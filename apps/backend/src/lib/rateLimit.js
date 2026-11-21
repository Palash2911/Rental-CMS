import { isIP } from "node:net";

import { getOperationAST, Kind, OperationTypeNode } from "graphql";

import { TooManyRequestsError } from "./errors.js";

/** Every limit uses the same fixed window, started by a key's first hit. */
export const RATE_LIMIT_WINDOW_MS = 60_000;

/** Requests (or root mutation fields) allowed per window, per bucket. */
export const RATE_LIMITS = Object.freeze({
  ANONYMOUS: Object.freeze({ name: "ip", limit: 60 }),
  USER: Object.freeze({ name: "user", limit: 300 }),
  MUTATION: Object.freeze({ name: "mutation", limit: 60 }),
  SENSITIVE: Object.freeze({ name: "sensitive", limit: 10 }),
});

/** Mutations that cost money, send something or hit Stripe; they share one tighter bucket. */
export const SENSITIVE_MUTATIONS = Object.freeze([
  "createInvitation",
  "createMemberInvitation",
  "startCheckout",
  "openBillingPortal",
  "requestReceiptUpload",
]);

/** Queries that return a whole data set in one response; they share the sensitive bucket. */
export const SENSITIVE_QUERIES = Object.freeze(["tenancyExport"]);

const KEY_PREFIX = "ratelimit";
const MS_PER_SECOND = 1000;
const UNKNOWN_IP = "unknown";
const IPV4_MAPPED_PREFIX = "::ffff:";
const FORWARDED_FOR_HEADER = "x-forwarded-for";
const FORWARDED_FOR_SEPARATOR = ",";
const INTROSPECTION_PREFIX = "__";
const IPV6_FAMILY = 6;
const IPV6_HEXTETS = 8;
const IPV6_PREFIX_HEXTETS = 4;
const IPV6_PREFIX_SUFFIX = "/64";
const IPV6_SEPARATOR = ":";
const IPV6_COMPRESSION = "::";
const IPV6_ZONE_SEPARATOR = "%";
const IPV4_SEPARATOR = ".";
const HEX_RADIX = 16;
const FAIL_OPEN_MESSAGE = "Rate limit skipped: Redis is unavailable.";

function normaliseIp(ip) {
  return ip.startsWith(IPV4_MAPPED_PREFIX) &&
    isIP(ip.slice(IPV4_MAPPED_PREFIX.length))
    ? ip.slice(IPV4_MAPPED_PREFIX.length)
    : ip;
}

function hextets(part) {
  return part === "" ? [] : part.split(IPV6_SEPARATOR);
}

// An embedded IPv4 tail (for example 64:ff9b::192.0.2.1) fills the last two hextets. Their
// values never matter here: they lie outside the /64 prefix.
function withoutEmbeddedIpv4(groups) {
  return groups.at(-1)?.includes(IPV4_SEPARATOR)
    ? [...groups.slice(0, -1), "0", "0"]
    : groups;
}

// A single client usually controls a whole /64, so per-address IPv6 buckets could be rotated
// around. Returns the canonical prefix, such as "2001:db8:0:1::/64", for a valid IPv6 address.
function ipv6Prefix64(ip) {
  const address = ip.split(IPV6_ZONE_SEPARATOR)[0].toLowerCase();
  const compressed = address.includes(IPV6_COMPRESSION);
  const [head, tail = ""] = compressed
    ? address.split(IPV6_COMPRESSION)
    : [address];
  const headGroups = withoutEmbeddedIpv4(hextets(head));
  const tailGroups = withoutEmbeddedIpv4(hextets(tail));
  const zeros = Array(
    IPV6_HEXTETS - headGroups.length - tailGroups.length,
  ).fill("0");
  const groups = compressed
    ? [...headGroups, ...zeros, ...tailGroups]
    : headGroups;

  const prefix = groups
    .slice(0, IPV6_PREFIX_HEXTETS)
    .map((group) => Number.parseInt(group, HEX_RADIX).toString(HEX_RADIX));

  return `${prefix.join(IPV6_SEPARATOR)}${IPV6_COMPRESSION}${IPV6_PREFIX_SUFFIX}`;
}

function bucketForIp(ip) {
  return isIP(ip) === IPV6_FAMILY ? ipv6Prefix64(ip) : ip;
}

// With one trusted proxy in front, the last X-Forwarded-For entry is the one that proxy
// appended (the address it saw); every earlier entry is supplied by the client and spoofable.
function forwardedIp(request) {
  const header = request?.headers?.get(FORWARDED_FOR_HEADER);

  if (!header) {
    return null;
  }

  const last = header.split(FORWARDED_FOR_SEPARATOR).at(-1).trim();
  return isIP(last) ? last : null;
}

/**
 * The client address used for the anonymous limit: the socket's remote address, or the last
 * X-Forwarded-For entry only when `trustProxy` is set. Never trusts the header otherwise.
 */
// The returned id is the bucket: an IPv4 address as is, an IPv6 address as its /64 prefix.
export function clientIp({ request, req, trustProxy }) {
  const forwarded = trustProxy ? forwardedIp(request) : null;
  const ip = forwarded ?? req?.socket?.remoteAddress ?? UNKNOWN_IP;
  return bucketForIp(normaliseIp(ip));
}

/**
 * Counts `amount` hits against `bucket` for `id` and throws TooManyRequestsError once the
 * window's count exceeds the bucket's limit. Fails open: when Redis errors, the request is
 * allowed and a warning goes to `log` (the request-scoped logger).
 */
export async function enforceRateLimit({ redis, log, bucket, id, amount = 1 }) {
  let count;
  let remainingMs;

  try {
    [count, remainingMs] = await redis.rateLimitHit(
      `${KEY_PREFIX}:${bucket.name}:${id}`,
      amount,
      RATE_LIMIT_WINDOW_MS,
    );
  } catch (error) {
    log.warn({ err: error, bucket: bucket.name }, FAIL_OPEN_MESSAGE);
    return;
  }

  if (count > bucket.limit) {
    throw new TooManyRequestsError(remainingMs / MS_PER_SECOND);
  }
}

function fragmentsByName(document) {
  const fragments = new Map();

  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }

  return fragments;
}

// Root fields through inline fragments and fragment spreads, so aliases or fragments cannot
// hide extra mutations from the count. Validation has already rejected fragment cycles; the
// visited set only stops a fragment spread twice from being counted twice.
function collectRootFields(selectionSet, fragments, visited, names) {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (!selection.name.value.startsWith(INTROSPECTION_PREFIX)) {
        names.push(selection.name.value);
      }
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      collectRootFields(selection.selectionSet, fragments, visited, names);
    } else if (!visited.has(selection.name.value)) {
      visited.add(selection.name.value);
      const fragment = fragments.get(selection.name.value);

      if (fragment) {
        collectRootFields(fragment.selectionSet, fragments, visited, names);
      }
    }
  }

  return names;
}

/**
 * The type (`query`, `mutation`, `subscription`) and root field names of the operation that
 * will run, or `{ type: null, fields: [] }` when there is none.
 */
export function operationRootFields(document, operationName) {
  const operation = getOperationAST(document, operationName);

  if (!operation) {
    return { type: null, fields: [] };
  }

  return {
    type: operation.operation,
    fields: collectRootFields(
      operation.selectionSet,
      fragmentsByName(document),
      new Set(),
      [],
    ),
  };
}

/** The root field names of the operation that will run when it is a mutation, otherwise []. */
export function mutationRootFields(document, operationName) {
  const { type, fields } = operationRootFields(document, operationName);
  return type === OperationTypeNode.MUTATION ? fields : [];
}

function countSensitive(type, fields) {
  const names =
    type === OperationTypeNode.MUTATION
      ? SENSITIVE_MUTATIONS
      : SENSITIVE_QUERIES;
  return fields.filter((name) => names.includes(name)).length;
}

/**
 * Yoga plugin for the per-user mutation and sensitive limits, which need the parsed
 * operation. Each root field counts as one hit, so one request cannot run many through
 * aliases. Anonymous requests are covered by the per-IP limit in createContext instead.
 */
export function createRateLimitPlugin() {
  return {
    async onExecute({ args, setResultAndStopExecution }) {
      const context = args.contextValue;
      const { type, fields } = operationRootFields(
        args.document,
        args.operationName,
      );
      const isMutation = type === OperationTypeNode.MUTATION;
      const sensitive = countSensitive(type, fields);

      if (
        !context.userId ||
        (!isMutation && sensitive === 0) ||
        fields.length === 0
      ) {
        return;
      }

      const common = {
        redis: context.redis,
        log: context.log,
        id: context.userId,
      };

      try {
        if (isMutation) {
          await enforceRateLimit({
            ...common,
            bucket: RATE_LIMITS.MUTATION,
            amount: fields.length,
          });
        }

        if (sensitive > 0) {
          await enforceRateLimit({
            ...common,
            bucket: RATE_LIMITS.SENSITIVE,
            amount: sensitive,
          });
        }
      } catch (error) {
        if (!(error instanceof TooManyRequestsError)) {
          throw error;
        }

        setResultAndStopExecution({ errors: [error] });
      }
    },
  };
}
