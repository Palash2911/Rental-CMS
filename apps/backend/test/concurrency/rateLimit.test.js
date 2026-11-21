import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { RATE_LIMITS } from "../../src/lib/rateLimit.js";
import { resetDatabase } from "../support/db.js";
import { firebaseUid } from "../support/factories.js";
import { postGraphql, startTestServer, tokenFor } from "../support/http.js";

const ROUNDS = 3;
const EXTRA = 20;
const PING = "query { __typename }";
const CHECKOUT = `mutation { startCheckout(ownerAccountId: "cjld2cjxh0000qzrmn831i7rn", plan: STARTER, interval: MONTH) { url } }`;

function statuses(results) {
  return {
    ok: results.filter((result) => result.status === 200).length,
    limited: results.filter((result) => result.status === 429).length,
  };
}

beforeEach(resetDatabase);

describe("concurrent requests against one bucket", () => {
  it("lets exactly the limit through when anonymous requests arrive together", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const { url } = await startTestServer();
      const total = RATE_LIMITS.ANONYMOUS.limit + EXTRA;

      const results = await Promise.all(Array.from({ length: total }, () => postGraphql(url, PING)));

      assert.deepEqual(statuses(results), { ok: RATE_LIMITS.ANONYMOUS.limit, limited: EXTRA }, `round ${round}`);
    }
  });

  it("lets exactly the sensitive limit through when one user's mutations arrive together", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const { url } = await startTestServer();
      const token = tokenFor(firebaseUid());
      const total = RATE_LIMITS.SENSITIVE.limit + EXTRA;

      const results = await Promise.all(Array.from({ length: total }, () => postGraphql(url, CHECKOUT, { token })));

      assert.deepEqual(statuses(results), { ok: RATE_LIMITS.SENSITIVE.limit, limited: EXTRA }, `round ${round}`);
    }
  });
});
