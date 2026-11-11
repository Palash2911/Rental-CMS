import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import {
  buildPageQuery,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationFields,
  toPage,
} from "../../src/lib/pagination.js";

const pageSchema = z.object(paginationFields);

function row(isoDate, id) {
  return { createdAt: new Date(isoDate), id };
}

function cursorFor(rowValue) {
  const page = toPage([rowValue, row("2000-01-01T00:00:00.000Z", "z")], 1, (item) => item);
  return page.pageInfo.nextCursor;
}

describe("pagination fields", () => {
  it("defaults first to 20", () => {
    assert.equal(pageSchema.parse({}).first, DEFAULT_PAGE_SIZE);
    assert.equal(pageSchema.parse({ first: null }).first, DEFAULT_PAGE_SIZE);
  });

  it("accepts first from 1 to 100 and rejects values outside", () => {
    assert.equal(pageSchema.parse({ first: 1 }).first, 1);
    assert.equal(pageSchema.parse({ first: MAX_PAGE_SIZE }).first, MAX_PAGE_SIZE);

    for (const first of [0, -1, MAX_PAGE_SIZE + 1, 2.5]) {
      assert.equal(pageSchema.safeParse({ first }).success, false, String(first));
    }
  });

  it("decodes a cursor produced by toPage", () => {
    const original = row("2026-11-01T10:00:00.000Z", "abc");
    const { after } = pageSchema.parse({ after: cursorFor(original) });

    assert.deepEqual(after, { createdAt: original.createdAt, id: "abc" });
  });

  it("rejects malformed, tampered and oversize cursors", () => {
    const tampered = Buffer.from(JSON.stringify({ c: "not a date", i: "x" })).toString("base64url");
    const missingId = Buffer.from(JSON.stringify({ c: "2026-11-01T10:00:00.000Z" })).toString("base64url");

    for (const after of ["%%%", tampered, missingId, "a".repeat(513)]) {
      const result = pageSchema.safeParse({ after });
      assert.equal(result.success, false);
    }
  });

  it("reports a safe message for an invalid cursor", () => {
    const result = pageSchema.safeParse({ after: "not-a-cursor" });

    assert.equal(result.error.issues[0].message, "Invalid pagination cursor.");
  });
});

describe("buildPageQuery", () => {
  it("orders newest first with id as tie-breaker and fetches one extra row", () => {
    const query = buildPageQuery({ first: 10, after: null });

    assert.deepEqual(query.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(query.take, 11);
    assert.deepEqual(query.where, {});
  });

  it("builds a keyset filter that breaks createdAt ties by id", () => {
    const after = { createdAt: new Date("2026-11-01T10:00:00.000Z"), id: "m" };
    const query = buildPageQuery({ first: 5, after });

    assert.deepEqual(query.where, {
      OR: [
        { createdAt: { lt: after.createdAt } },
        { createdAt: after.createdAt, id: { lt: "m" } },
      ],
    });
  });
});

describe("toPage", () => {
  it("returns hasNextPage and a cursor when an extra row was fetched", () => {
    const rows = [row("2026-11-03T00:00:00.000Z", "c"), row("2026-11-02T00:00:00.000Z", "b"), row("2026-11-01T00:00:00.000Z", "a")];
    const page = toPage(rows, 2, (item) => item.id);

    assert.deepEqual(page.items, ["c", "b"]);
    assert.equal(page.pageInfo.hasNextPage, true);
    assert.deepEqual(pageSchema.parse({ after: page.pageInfo.nextCursor }).after, {
      createdAt: rows[1].createdAt,
      id: "b",
    });
  });

  it("returns no cursor on the last page", () => {
    const page = toPage([row("2026-11-01T00:00:00.000Z", "a")], 2, (item) => item.id);

    assert.deepEqual(page, { items: ["a"], pageInfo: { nextCursor: null, hasNextPage: false } });
  });
});
