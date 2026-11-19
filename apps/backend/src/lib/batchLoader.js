const loadersByContext = new WeakMap();

function createBatchLoader(batchFn) {
  const cache = new Map();
  let queue = [];

  async function flush() {
    const batch = queue;
    queue = [];

    try {
      const results = await batchFn(batch.map((entry) => entry.key));

      for (const { key, resolve, reject } of batch) {
        if (results.has(key)) {
          resolve(results.get(key));
        } else {
          reject(new Error(`Batch loader returned no value for ${key}.`));
        }
      }
    } catch (error) {
      for (const { reject } of batch) {
        reject(error);
      }
    }
  }

  return {
    load(key) {
      if (cache.has(key)) {
        return cache.get(key);
      }

      const promise = new Promise((resolve, reject) => {
        queue.push({ key, resolve, reject });

        // setImmediate runs after every pending promise callback, so all sibling field
        // resolvers of a list have queued their keys before the batch is fetched.
        if (queue.length === 1) {
          setImmediate(flush);
        }
      });

      cache.set(key, promise);
      return promise;
    },
  };
}

/**
 * Returns the request-scoped loader `name` for `context`, creating it on first use.
 * `batchFn(keys)` must resolve to a Map with a value for every key. Values are cached for
 * the request, so a key is fetched at most once per request. This avoids N+1 queries for
 * fields resolved per list item.
 */
export function batchLoaderFor(context, name, batchFn) {
  let loaders = loadersByContext.get(context);

  if (!loaders) {
    loaders = new Map();
    loadersByContext.set(context, loaders);
  }

  if (!loaders.has(name)) {
    loaders.set(name, createBatchLoader(batchFn));
  }

  return loaders.get(name);
}
