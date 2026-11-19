import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { batchLoaderFor } from "../../src/lib/batchLoader.js";

function recordingBatch() {
  const batches = [];
  const batchFn = async (keys) => {
    batches.push([...keys]);
    return new Map(keys.map((key) => [key, `value-${key}`]));
  };
  return { batches, batchFn };
}

describe("batchLoaderFor", () => {
  it("fetches every key requested in the same turn in one batch", async () => {
    const context = {};
    const { batches, batchFn } = recordingBatch();
    const load = (key) => batchLoaderFor(context, "test", batchFn).load(key);

    const values = await Promise.all(["a", "b", "c"].map(load));

    assert.deepEqual(values, ["value-a", "value-b", "value-c"]);
    assert.deepEqual(batches, [["a", "b", "c"]]);
  });

  it("caches values per context, so a key is fetched once per request", async () => {
    const context = {};
    const { batches, batchFn } = recordingBatch();
    const loader = batchLoaderFor(context, "test", batchFn);

    await Promise.all([loader.load("a"), loader.load("a")]);
    await loader.load("a");

    assert.deepEqual(batches, [["a"]]);
  });

  it("keeps loaders apart per context and per name", async () => {
    const { batches, batchFn } = recordingBatch();

    await Promise.all([
      batchLoaderFor({}, "test", batchFn).load("a"),
      batchLoaderFor({}, "test", batchFn).load("a"),
    ]);

    assert.equal(batches.length, 2);
  });

  it("rejects a key the batch function did not return, and every key when it throws", async () => {
    const missing = batchLoaderFor({}, "test", async () => new Map());
    await assert.rejects(missing.load("a"), /no value for a/);

    const failing = batchLoaderFor({}, "test", async () => {
      throw new Error("database down");
    });
    const results = await Promise.allSettled([failing.load("a"), failing.load("b")]);
    assert.deepEqual(results.map((result) => result.reason?.message), ["database down", "database down"]);
  });
});
