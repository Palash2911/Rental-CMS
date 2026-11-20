import { HTTP_STATUS, UnauthenticatedError } from "../lib/errors.js";
import { clientIp, enforceRateLimit, RATE_LIMITS } from "../lib/rateLimit.js";

const ANONYMOUS_IDENTITY = Object.freeze({
  userId: null,
  email: null,
  emailVerified: false,
  name: null,
  isSuperAdmin: false,
});

const BEARER_PREFIX = /^Bearer\s+/i;

// Headers trims surrounding whitespace from values, so "Bearer " with no token
// arrives as just "Bearer" and must be matched on its own.
const BEARER_ONLY = /^Bearer$/i;

function unauthenticated(message) {
  return new UnauthenticatedError(message, {
    httpStatus: HTTP_STATUS.UNAUTHORIZED,
  });
}

const BILLING_GATEWAY_METHODS = Object.freeze([
  "createCustomer",
  "findPriceIdByLookupKey",
  "createCheckoutSession",
  "retrieveCheckoutSession",
  "expireCheckoutSession",
  "createPortalSession",
  "retrieveSubscription",
  "updateCustomerEmail",
  "cancelSubscription",
]);

// The commands the rate limit (createRedisClient's rateLimitHit) and the user cache use.
const REDIS_METHODS = Object.freeze(["rateLimitHit", "get", "set", "del"]);

function assertBillingGateway(billingGateway) {
  const valid =
    billingGateway !== null &&
    typeof billingGateway === "object" &&
    BILLING_GATEWAY_METHODS.every((name) => typeof billingGateway[name] === "function");

  if (!valid) {
    throw new TypeError(
      `createContextFactory requires a billingGateway with ${BILLING_GATEWAY_METHODS.join(", ")}.`,
    );
  }
}

function assertRedis(redis) {
  const valid =
    redis !== null &&
    typeof redis === "object" &&
    REDIS_METHODS.every((name) => typeof redis[name] === "function");

  if (!valid) {
    throw new TypeError(
      `createContextFactory requires a redis client with ${REDIS_METHODS.join(", ")}.`,
    );
  }
}

function assertDependencies({
  prisma,
  verifyIdToken,
  hasLiveSuperAdminClaim,
  billingGateway,
  redis,
  trustProxy,
}) {
  assertBillingGateway(billingGateway);
  assertRedis(redis);

  if (trustProxy !== undefined && typeof trustProxy !== "boolean") {
    throw new TypeError("createContextFactory requires trustProxy to be a boolean.");
  }

  if (prisma === null || typeof prisma !== "object") {
    throw new TypeError("createContextFactory requires a prisma client.");
  }

  if (typeof verifyIdToken !== "function") {
    throw new TypeError(
      "createContextFactory requires a verifyIdToken function.",
    );
  }

  if (typeof hasLiveSuperAdminClaim !== "function") {
    throw new TypeError(
      "createContextFactory requires a hasLiveSuperAdminClaim function.",
    );
  }
}

/**
 * Returns the createContext function Yoga calls per request. Dependencies are
 * injected so the context can be built without Firebase. verifyIdToken must throw
 * UnauthenticatedError (HTTP 401) for a bad token and rethrow anything else.
 * Throws TypeError immediately if a dependency is missing or invalid.
 */
// `redis` backs the rate limit and the user cache; `trustProxy` lets the anonymous limit read
// X-Forwarded-For.
export function createContextFactory(dependencies) {
  assertDependencies(dependencies ?? {});
  const {
    prisma,
    verifyIdToken,
    hasLiveSuperAdminClaim,
    billingGateway,
    redis,
    trustProxy = false,
  } = dependencies;

  async function identify(authHeader) {
    if (BEARER_ONLY.test(authHeader)) {
      throw unauthenticated("Missing bearer token.");
    }

    if (!BEARER_PREFIX.test(authHeader)) {
      throw unauthenticated(
        "Authorization header must use the Bearer scheme.",
      );
    }

    const token = authHeader.replace(BEARER_PREFIX, "").trim();

    if (!token) {
      throw unauthenticated("Missing bearer token.");
    }

    const decoded = await verifyIdToken(token);

    return {
      userId: decoded.uid,
      email: decoded.email ?? null,
      emailVerified: decoded.email_verified === true,
      name: typeof decoded.name === "string" && decoded.name ? decoded.name : null,
      isSuperAdmin: decoded.superAdmin === true,
    };
  }

  /**
   * Builds the per-request GraphQL context from the Authorization header.
   * Throws UnauthenticatedError (HTTP 401) for a malformed header or an invalid,
   * expired or revoked token. Any other verification failure, such as Firebase
   * being unreachable, is rethrown unchanged so Yoga masks it as a server error.
   */
  // The request-level rate limit runs here, before any resolver: per user for a valid token,
  // otherwise per client IP. A bad header or token also counts against the IP, so token
  // guessing is limited too. Over a limit it throws TooManyRequestsError (HTTP 429). `log` is
  // Yoga's request-scoped logger from the initial context.
  return async function createContext({ request, req, log }) {
    const authHeader = request.headers.get("authorization");
    const limitByIp = () =>
      enforceRateLimit({
        redis,
        log,
        bucket: RATE_LIMITS.ANONYMOUS,
        id: clientIp({ request, req, trustProxy }),
      });

    let identity = ANONYMOUS_IDENTITY;

    if (authHeader) {
      try {
        identity = await identify(authHeader);
      } catch (error) {
        if (error instanceof UnauthenticatedError) {
          await limitByIp();
        }

        throw error;
      }

      await enforceRateLimit({ redis, log, bucket: RATE_LIMITS.USER, id: identity.userId });
    } else {
      await limitByIp();
    }

    return {
      prisma,
      ...identity,
      hasLiveSuperAdminClaim,
      billingGateway,
      redis,
    };
  };
}
