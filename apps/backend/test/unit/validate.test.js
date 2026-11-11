import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { BadUserInputError } from "../../src/lib/errors.js";
import {
  calendarDateSchema,
  cuidIdSchema,
  userIdSchema,
  validate,
} from "../../src/lib/validate.js";

function fieldErrorsOf(schema, input) {
  try {
    validate(schema, input);
  } catch (error) {
    assert.ok(error instanceof BadUserInputError);
    return error.extensions.fieldErrors;
  }

  return assert.fail("Expected validation to fail");
}

describe("validate", () => {
  it("returns parsed data on success", () => {
    const schema = z.object({ name: z.string().trim() });

    assert.deepEqual(validate(schema, { name: "  Ana  " }), { name: "Ana" });
  });

  it("reports dot-joined paths for nested fields", () => {
    const schema = z.object({ input: z.object({ name: z.string().min(2) }) });
    const [error] = fieldErrorsOf(schema, { input: { name: "a" } });

    assert.equal(error.path, "input.name");
  });

  it("does not echo unknown key names", () => {
    const schema = z.strictObject({ name: z.string() });
    const errors = fieldErrorsOf(schema, { name: "a", secretField: 1 });

    assert.deepEqual(errors.map((error) => error.message), ["Unrecognized field."]);
    assert.doesNotMatch(JSON.stringify(errors), /secretField/);
  });

  it("does not expose regex patterns", () => {
    const [error] = fieldErrorsOf(userIdSchema, "has spaces");

    assert.equal(error.message, "Invalid format.");
  });

  it("describes type errors without the received value", () => {
    const [error] = fieldErrorsOf(z.object({ count: z.number() }), { count: "seven" });

    assert.equal(error.message, "Invalid type: expected number.");
    assert.doesNotMatch(error.message, /seven/);
  });

  it("keeps schema-authored messages", () => {
    const schema = z.string().refine(() => false, "Custom safe message.");
    const [error] = fieldErrorsOf(schema, "x");

    assert.equal(error.message, "Custom safe message.");
  });

  it("caps fieldErrors at 50", () => {
    const schema = z.array(z.number());
    const errors = fieldErrorsOf(schema, Array.from({ length: 80 }, () => "x"));

    assert.equal(errors.length, 50);
  });

  it("uses an empty path for root-level issues", () => {
    const [error] = fieldErrorsOf(z.string(), 5);

    assert.equal(error.path, "");
  });
});

describe("id schemas", () => {
  it("accepts a cuid and rejects other strings", () => {
    assert.equal(cuidIdSchema.safeParse("cjld2cjxh0000qzrmn831i7rn").success, true);
    assert.equal(cuidIdSchema.safeParse("not a cuid").success, false);
  });

  it("accepts Firebase-style user ids up to 128 characters", () => {
    assert.equal(userIdSchema.safeParse("aB3_-xYz").success, true);
    assert.equal(userIdSchema.safeParse("a".repeat(129)).success, false);
    assert.equal(userIdSchema.safeParse("").success, false);
  });
});

describe("calendarDateSchema", () => {
  it("parses YYYY-MM-DD to UTC midnight", () => {
    const date = calendarDateSchema.parse("2026-11-01");

    assert.equal(date.toISOString(), "2026-11-01T00:00:00.000Z");
  });

  it("accepts a leap day and rejects an impossible date", () => {
    assert.equal(calendarDateSchema.safeParse("2028-02-29").success, true);
    assert.equal(calendarDateSchema.safeParse("2026-02-29").success, false);
    assert.equal(calendarDateSchema.safeParse("2026-02-30").success, false);
  });

  it("accepts years 2000 to 2100 only", () => {
    assert.equal(calendarDateSchema.safeParse("2000-01-01").success, true);
    assert.equal(calendarDateSchema.safeParse("2100-12-31").success, true);
    assert.equal(calendarDateSchema.safeParse("1999-12-31").success, false);
    assert.equal(calendarDateSchema.safeParse("2101-01-01").success, false);
  });

  it("rejects timestamps and other formats", () => {
    for (const value of ["2026-11-01T00:00:00Z", "01/11/2026", "2026-1-1", ""]) {
      assert.equal(calendarDateSchema.safeParse(value).success, false, value);
    }
  });

  it("reports exactly one error for a malformed date", () => {
    const errors = fieldErrorsOf(z.object({ date: calendarDateSchema }), { date: "2026-02-30" });

    assert.deepEqual(errors, [
      { path: "date", message: "Enter a valid calendar date as YYYY-MM-DD." },
    ]);
  });

  it("reports the year range message for an out-of-range year", () => {
    const errors = fieldErrorsOf(z.object({ date: calendarDateSchema }), { date: "1999-12-31" });

    assert.deepEqual(errors, [
      { path: "date", message: "Dates must fall between 2000 and 2100." },
    ]);
  });
});
