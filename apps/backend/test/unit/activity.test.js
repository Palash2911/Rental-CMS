import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ACTIVITY_ACTIONS, ENTITY_TYPES, logActivity } from "../../src/lib/activity.js";

function recordingTx() {
  const calls = [];

  return {
    calls,
    activityLog: {
      create: async (args) => {
        calls.push(args);
        return { id: "c0000000" };
      },
    },
  };
}

const ENTRY = Object.freeze({
  entityType: ENTITY_TYPES.HOUSE,
  entityId: "chouse001",
  action: ACTIVITY_ACTIONS.CREATED,
  performedByUserId: "user-1",
});

describe("logActivity", () => {
  it("writes ownerAccountId with the entry", async () => {
    const tx = recordingTx();

    await logActivity(tx, { ...ENTRY, ownerAccountId: "caccount1", metadata: { a: 1 } });

    assert.deepEqual(tx.calls[0].data, { ...ENTRY, ownerAccountId: "caccount1", metadata: { a: 1 } });
  });

  it("accepts an explicit null ownerAccountId", async () => {
    const tx = recordingTx();

    await logActivity(tx, { ...ENTRY, ownerAccountId: null });

    assert.equal(tx.calls[0].data.ownerAccountId, null);
  });

  it("throws TypeError and writes nothing when ownerAccountId is omitted", () => {
    const tx = recordingTx();

    assert.throws(() => logActivity(tx, ENTRY), TypeError);
    assert.equal(tx.calls.length, 0);
  });
});
