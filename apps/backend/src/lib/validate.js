import { z } from "zod";

import { BadUserInputError } from "./errors.js";

const MAX_FIELD_ERRORS = 50;
const PATH_SEPARATOR = ".";
const REGEX_FORMAT = "regex";

const USER_ID_MAX_LENGTH = 128;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Same pattern and message as zod 4.6.7's deprecated z.cuid() (zod/v4/core/regexes.js), so
// accepted ids and client messages are unchanged.
const CUID_PATTERN = /^[cC][0-9a-z]{6,}$/;
const CUID_MESSAGE = "Invalid cuid";

/** Id rule for models whose ids Prisma generates with cuid() (OwnerAccount, House and the rest). */
export const cuidIdSchema = z.string().regex(CUID_PATTERN, CUID_MESSAGE);

/** Id rule for User ids, which are Firebase UIDs, not cuids. */
export const userIdSchema = z
  .string()
  .min(1)
  .max(USER_ID_MAX_LENGTH)
  .regex(USER_ID_PATTERN);

const CALENDAR_YEAR_RANGE = Object.freeze({ MIN: 2000, MAX: 2100 });
const UTC_MIDNIGHT_SUFFIX = "T00:00:00.000Z";
const YEAR_LENGTH = 4;

const DATE_MESSAGES = Object.freeze({
  INVALID_DATE: "Enter a valid calendar date as YYYY-MM-DD.",
  YEAR_OUT_OF_RANGE: `Dates must fall between ${CALENDAR_YEAR_RANGE.MIN} and ${CALENDAR_YEAR_RANGE.MAX}.`,
});

function toUtcMidnight(value) {
  return new Date(`${value}${UTC_MIDNIGHT_SUFFIX}`);
}

function isRealCalendarDate(value) {
  const date = toUtcMidnight(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isYearInRange(value) {
  const year = Number(value.slice(0, YEAR_LENGTH));
  return year >= CALENDAR_YEAR_RANGE.MIN && year <= CALENDAR_YEAR_RANGE.MAX;
}

/**
 * Calendar date rule: a real YYYY-MM-DD date with a year from 2000 to 2100, parsed to a Date
 * at UTC midnight. Services format it back with toCalendarDate.
 */
export const calendarDateSchema = z.iso
  .date({ error: DATE_MESSAGES.INVALID_DATE, abort: true })
  .refine(isRealCalendarDate, { message: DATE_MESSAGES.INVALID_DATE, abort: true })
  .refine(isYearInRange, DATE_MESSAGES.YEAR_OUT_OF_RANGE)
  .transform(toUtcMidnight);

/**
 * A calendar date input after the Date scalar parsed it (a Date at UTC midnight). Domain
 * schemas use this; the format and year rules run in the scalar through calendarDateSchema.
 */
export const parsedCalendarDateSchema = z.date();

const SAFE_MESSAGES = Object.freeze({
  UNRECOGNIZED_KEY: "Unrecognized field.",
  INVALID_FORMAT: "Invalid format.",
});

// Zod's default English messages echo client-supplied key names and internal regex
// patterns. A per-parse map only replaces defaults: check- and schema-level messages
// still take precedence, so authored messages pass through unchanged.
function safeDefaultMessage(issue) {
  switch (issue.code) {
    case "unrecognized_keys":
      return SAFE_MESSAGES.UNRECOGNIZED_KEY;
    case "invalid_format":
      return issue.format === REGEX_FORMAT
        ? SAFE_MESSAGES.INVALID_FORMAT
        : undefined;
    case "invalid_type":
      return `Invalid type: expected ${issue.expected}.`;
    default:
      return undefined;
  }
}

function toFieldError(issue) {
  return {
    path: issue.path.map(String).join(PATH_SEPARATOR),
    message: issue.message,
  };
}

/**
 * Parses input with a Zod schema and returns the parsed data.
 * Throws BadUserInputError with up to 50 `fieldErrors` when validation fails.
 */
export function validate(schema, input) {
  const result = schema.safeParse(input, { error: safeDefaultMessage });

  if (result.success) {
    return result.data;
  }

  const fieldErrors = result.error.issues
    .slice(0, MAX_FIELD_ERRORS)
    .map(toFieldError);

  throw new BadUserInputError(undefined, { fieldErrors });
}
