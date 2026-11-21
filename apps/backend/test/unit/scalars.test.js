import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Kind } from "graphql";

import { BadUserInputError, ERROR_CODES } from "../../src/lib/errors.js";
import {
  DateScalar,
  DateTimeScalar,
  JsonScalar,
} from "../../src/lib/scalars.js";

function stringLiteral(value) {
  return { kind: Kind.STRING, value };
}

function assertBadInput(fn, message) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BadUserInputError);
    assert.equal(error.extensions.code, ERROR_CODES.BAD_USER_INPUT);
    if (message !== undefined) {
      assert.equal(error.message, message);
    }
    return true;
  });
}

describe("DateTime scalar", () => {
  it("outputs a Date as an ISO 8601 UTC timestamp", () => {
    assert.equal(
      DateTimeScalar.coerceOutputValue(new Date("2026-11-01T09:30:00.000Z")),
      "2026-11-01T09:30:00.000Z",
    );
  });

  it("outputs an ISO UTC string from a service unchanged", () => {
    assert.equal(
      DateTimeScalar.coerceOutputValue("2026-11-01T09:30:00.000Z"),
      "2026-11-01T09:30:00.000Z",
    );
  });

  it("throws a TypeError, never a client error, for an output it cannot represent", () => {
    for (const value of [
      new Date("nope"),
      "2026-11-01",
      "2026-11-01T09:30:00+11:00",
      "2026-02-30T00:00:00.000Z",
      1_730_000_000_000,
      null,
      {},
    ]) {
      assert.throws(
        () => DateTimeScalar.coerceOutputValue(value),
        TypeError,
        String(value),
      );
    }
  });

  it("parses an input with Z or an offset to the same instant", () => {
    assert.equal(
      DateTimeScalar.coerceInputValue("2026-11-01T09:30:00Z").toISOString(),
      "2026-11-01T09:30:00.000Z",
    );
    assert.equal(
      DateTimeScalar.coerceInputValue(
        "2026-11-01T20:30:00+11:00",
      ).toISOString(),
      "2026-11-01T09:30:00.000Z",
    );
    assert.equal(
      DateTimeScalar.coerceInputLiteral(
        stringLiteral("2026-11-01T09:30:00.123Z"),
      ).toISOString(),
      "2026-11-01T09:30:00.123Z",
    );
  });

  it("refuses inputs without a time zone, dates only, impossible values and non-strings", () => {
    const message =
      "Enter a valid ISO 8601 date and time with a time zone, such as 2026-11-01T09:30:00Z.";

    for (const value of [
      "2026-11-01T09:30:00",
      "2026-11-01",
      "2026-13-01T00:00:00Z",
      "yesterday",
      "",
    ]) {
      assertBadInput(() => DateTimeScalar.coerceInputValue(value), message);
    }

    assertBadInput(
      () => DateTimeScalar.coerceInputValue(1_730_000_000_000),
      "Expected a string.",
    );
    assertBadInput(
      () => DateTimeScalar.coerceInputLiteral({ kind: Kind.INT, value: "1" }),
      "Expected a string.",
    );
  });
});

describe("Date scalar", () => {
  it("outputs a UTC-midnight Date or a service's YYYY-MM-DD string as YYYY-MM-DD", () => {
    assert.equal(
      DateScalar.coerceOutputValue(new Date("2026-11-01T00:00:00.000Z")),
      "2026-11-01",
    );
    assert.equal(DateScalar.coerceOutputValue("2028-02-29"), "2028-02-29");
  });

  it("throws a TypeError for an output it cannot represent", () => {
    for (const value of [
      new Date("2026-11-01T09:30:00.000Z"),
      "2026-02-30",
      "2026-11-01T00:00:00.000Z",
      20261101,
      null,
    ]) {
      assert.throws(
        () => DateScalar.coerceOutputValue(value),
        TypeError,
        String(value),
      );
    }
  });

  it("parses YYYY-MM-DD to a Date at UTC midnight, from variables and literals", () => {
    assert.equal(
      DateScalar.coerceInputValue("2026-11-01").toISOString(),
      "2026-11-01T00:00:00.000Z",
    );
    assert.equal(
      DateScalar.coerceInputLiteral(stringLiteral("2000-01-01")).toISOString(),
      "2000-01-01T00:00:00.000Z",
    );
    assert.equal(
      DateScalar.coerceInputValue("2100-12-31").toISOString(),
      "2100-12-31T00:00:00.000Z",
    );
  });

  it("refuses impossible dates and other formats with the calendar date message", () => {
    for (const value of [
      "2026-02-30",
      "2026-02-29",
      "2026-13-01",
      "2026-11-1",
      "01/11/2026",
      "2026-11-01T00:00:00Z",
      "",
    ]) {
      assertBadInput(
        () => DateScalar.coerceInputValue(value),
        "Enter a valid calendar date as YYYY-MM-DD.",
      );
    }
  });

  it("refuses years outside 2000 to 2100 with the year range message", () => {
    for (const value of ["1999-12-31", "2101-01-01"]) {
      assertBadInput(
        () => DateScalar.coerceInputValue(value),
        "Dates must fall between 2000 and 2100.",
      );
    }
  });

  it("refuses non-string inputs", () => {
    assertBadInput(
      () => DateScalar.coerceInputValue(20261101),
      "Expected a string.",
    );
    assertBadInput(
      () =>
        DateScalar.coerceInputLiteral({ kind: Kind.INT, value: "20261101" }),
      "Expected a string.",
    );
  });
});

describe("JSON", () => {
  it("outputs plain JSON values unchanged", () => {
    const value = { a: 1, b: [true, null, "x"], c: { d: -2.5 } };

    assert.deepEqual(JsonScalar.coerceOutputValue(value), value);
    assert.equal(JsonScalar.coerceOutputValue(null), null);
    assert.equal(JsonScalar.coerceOutputValue("text"), "text");
  });

  it("throws TypeError, masked as a server error, for values JSON cannot represent", () => {
    for (const value of [
      new Date(),
      Number.NaN,
      Infinity,
      { nested: undefined },
      () => {},
      10n,
    ]) {
      assert.throws(() => JsonScalar.coerceOutputValue(value), TypeError);
    }
  });

  it("refuses every input", () => {
    assertBadInput(
      () => JsonScalar.coerceInputValue({ a: 1 }),
      "JSON values are not accepted as input.",
    );
    assertBadInput(
      () => JsonScalar.coerceInputLiteral(stringLiteral("{}")),
      "JSON values are not accepted as input.",
    );
  });
});
