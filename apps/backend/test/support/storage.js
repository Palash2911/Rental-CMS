const GATEWAY_METHODS = Object.freeze([
  "presignUpload",
  "presignDownload",
  "headObject",
  "listKeys",
  "deleteObjects",
]);

const FAKE_ORIGIN = "https://storage.example.test";

/**
 * The default storage gateway for test contexts: every call rejects with an error that has
 * no GraphQL code, so a test that reaches storage unexpectedly fails.
 */
export function unexpectedStorageGateway() {
  return Object.freeze(
    Object.fromEntries(
      GATEWAY_METHODS.map((name) => [
        name,
        async () => {
          throw new Error(`Unexpected storage call: ${name}`);
        },
      ]),
    ),
  );
}

/**
 * An in-memory storage gateway with no network. `objects` maps keys to
 * `{ contentType, sizeBytes }`; `put` stands in for the browser's upload. `fail(name)` makes
 * that method reject until `heal(name)`; `pageSize` bounds listKeys pages so paging is tested.
 */
export function fakeStorageGateway({ pageSize = 1000 } = {}) {
  const objects = new Map();
  const calls = [];
  const failing = new Set();

  function guard(name, args) {
    calls.push({ name, args });

    if (failing.has(name)) {
      throw new Error(`Injected storage failure: ${name}`);
    }
  }

  const gateway = Object.freeze({
    async presignUpload({ key, contentType, sizeBytes, expiresInSeconds }) {
      guard("presignUpload", { key, contentType, sizeBytes, expiresInSeconds });
      const query = new URLSearchParams({ op: "put", type: contentType, size: String(sizeBytes), ttl: String(expiresInSeconds) });
      return `${FAKE_ORIGIN}/${key}?${query}`;
    },

    async presignDownload({ key, expiresInSeconds }) {
      guard("presignDownload", { key, expiresInSeconds });
      return `${FAKE_ORIGIN}/${key}?op=get&ttl=${expiresInSeconds}`;
    },

    async headObject(key) {
      guard("headObject", { key });
      return objects.has(key) ? { ...objects.get(key) } : null;
    },

    async listKeys({ prefix, continuationToken = null }) {
      guard("listKeys", { prefix, continuationToken });
      const matching = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const start = continuationToken ? matching.findIndex((key) => key > continuationToken) : 0;
      const keys = start === -1 ? [] : matching.slice(start, start + pageSize);
      const more = start !== -1 && start + pageSize < matching.length;
      return { keys, nextToken: more ? keys.at(-1) : null };
    },

    async deleteObjects(keys) {
      guard("deleteObjects", { keys: [...keys] });

      for (const key of keys) {
        objects.delete(key);
      }
    },
  });

  return {
    gateway,
    objects,
    calls,
    /** Stores an object as the browser's PUT would. */
    put(key, { contentType, sizeBytes }) {
      objects.set(key, { contentType, sizeBytes });
    },
    fail(name) {
      failing.add(name);
    },
    heal(name) {
      failing.delete(name);
    },
    callsTo(name) {
      return calls.filter((call) => call.name === name);
    },
  };
}
