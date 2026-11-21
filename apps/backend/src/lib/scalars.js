import { GraphQLScalarType, Kind } from "graphql";
import { z } from "zod";

import { BadUserInputError } from "./errors.js";
import { calendarDateSchema } from "./validate.js";

const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CALENDAR_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
const CALENDAR_DATE_LENGTH = 10;
const UTC_MIDNIGHT_SUFFIX = "T00:00:00.000Z";

const MESSAGES = Object.freeze({
  INVALID_DATE_TIME:
    "Enter a valid ISO 8601 date and time with a time zone, such as 2026-11-01T09:30:00Z.",
  STRING_REQUIRED: "Expected a string.",
  JSON_INPUT_NOT_ACCEPTED: "JSON values are not accepted as input.",
});

const dateTimeInputSchema = z.iso.datetime({ offset: true });

function isValidDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isCalendarDateString(value) {
  if (typeof value !== "string" || !CALENDAR_DATE_FORMAT.test(value)) {
    return false;
  }

  const date = new Date(`${value}${UTC_MIDNIGHT_SUFFIX}`);
  return isValidDate(date) && date.toISOString().startsWith(value);
}

function requireStringLiteral(ast) {
  if (ast.kind !== Kind.STRING) {
    throw new BadUserInputError(MESSAGES.STRING_REQUIRED);
  }

  return ast.value;
}

// Output values come from our own services, so a bad one is a server bug: TypeError is not
// a GraphQLError, so Yoga masks it as a server error instead of exposing the value.
function toDateTimeOutput(value) {
  if (isValidDate(value)) {
    return value.toISOString();
  }

  if (typeof value === "string" && ISO_UTC_TIMESTAMP.test(value)) {
    const date = new Date(value);

    if (isValidDate(date) && date.toISOString() === value) {
      return value;
    }
  }

  throw new TypeError("DateTime cannot represent this value.");
}

function toDateTimeInput(value) {
  if (typeof value !== "string") {
    throw new BadUserInputError(MESSAGES.STRING_REQUIRED);
  }

  if (!dateTimeInputSchema.safeParse(value).success) {
    throw new BadUserInputError(MESSAGES.INVALID_DATE_TIME);
  }

  return new Date(value);
}

function toDateOutput(value) {
  if (isValidDate(value) && value.toISOString().endsWith(UTC_MIDNIGHT_SUFFIX)) {
    return value.toISOString().slice(0, CALENDAR_DATE_LENGTH);
  }

  if (isCalendarDateString(value)) {
    return value;
  }

  throw new TypeError("Date cannot represent this value.");
}

// The calendar date rule (format, real date, year range) and its messages live in
// calendarDateSchema; the scalar reports its first failure as BAD_USER_INPUT.
function toDateInput(value) {
  if (typeof value !== "string") {
    throw new BadUserInputError(MESSAGES.STRING_REQUIRED);
  }

  const result = calendarDateSchema.safeParse(value);

  if (!result.success) {
    throw new BadUserInputError(result.error.issues[0].message);
  }

  return result.data;
}

/**
 * DateTime: an instant, sent as an ISO 8601 UTC timestamp (2026-11-01T09:30:00.000Z).
 * Inputs need a time zone (Z or an offset) and are parsed to a Date.
 */
export const DateTimeScalar = new GraphQLScalarType({
  name: "DateTime",
  description: "An ISO 8601 timestamp in UTC, such as 2026-11-01T09:30:00.000Z.",
  coerceOutputValue: toDateTimeOutput,
  coerceInputValue: toDateTimeInput,
  coerceInputLiteral: (ast) => toDateTimeInput(requireStringLiteral(ast)),
});

/**
 * Date: a calendar date with no time or time zone, sent as YYYY-MM-DD.
 * Inputs must be real dates from 2000 to 2100 and are parsed to a Date at UTC midnight.
 */
export const DateScalar = new GraphQLScalarType({
  name: "Date",
  description: "A calendar date as YYYY-MM-DD, such as 2026-11-01.",
  coerceOutputValue: toDateOutput,
  coerceInputValue: toDateInput,
  coerceInputLiteral: (ast) => toDateInput(requireStringLiteral(ast)),
});

function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function toJsonOutput(value) {
  if (isJsonValue(value)) {
    return value;
  }

  throw new TypeError("JSON cannot represent this value.");
}

// Output only: no operation takes free-form JSON, so any JSON input is refused rather than
// passed unchecked to a resolver.
function rejectJsonInput() {
  throw new BadUserInputError(MESSAGES.JSON_INPUT_NOT_ACCEPTED);
}

/** JSON: any JSON value, for stored metadata. Output only; inputs are refused. */
export const JsonScalar = new GraphQLScalarType({
  name: "JSON",
  description: "Any JSON value. Used for output only.",
  coerceOutputValue: toJsonOutput,
  coerceInputValue: rejectJsonInput,
  coerceInputLiteral: rejectJsonInput,
});

export const scalarTypeDefs = `
  scalar DateTime
  scalar Date
  scalar JSON
`;

export const scalarResolvers = Object.freeze({
  DateTime: DateTimeScalar,
  Date: DateScalar,
  JSON: JsonScalar,
});
