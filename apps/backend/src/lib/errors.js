import { GraphQLError } from "graphql";

import { Prisma } from "../generated/prisma/client.ts";

/**
 * Every error code a client can receive. INTERNAL_SERVER_ERROR has no class:
 * Yoga's error masking assigns it to every unknown error.
 */
export const ERROR_CODES = Object.freeze({
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  BAD_USER_INPUT: "BAD_USER_INPUT",
  CONFLICT: "CONFLICT",
  INTERNAL_SERVER_ERROR: "INTERNAL_SERVER_ERROR",
});

/**
 * HTTP statuses that request-level code (context.js) may opt into.
 * Resolver and service errors never set one, so they return HTTP 200.
 */
export const HTTP_STATUS = Object.freeze({
  UNAUTHORIZED: 401,
});

const DEFAULT_MESSAGES = Object.freeze({
  UNAUTHENTICATED: "Authentication required.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "Resource not found.",
  BAD_USER_INPUT: "Invalid input.",
  CONFLICT: "The request conflicts with the current state of the resource.",
});

const PRISMA_ERROR_CODES = Object.freeze({
  UNIQUE_VIOLATION: "P2002",
  FOREIGN_KEY_VIOLATION: "P2003",
  RECORD_NOT_FOUND: "P2025",
});

const PRISMA_ERROR_MESSAGES = Object.freeze({
  UNIQUE_VIOLATION: "A record with these details already exists.",
  FOREIGN_KEY_VIOLATION: "This action conflicts with related records.",
});

class AppError extends GraphQLError {
  constructor(message, code, { httpStatus, extensions } = {}) {
    const allExtensions = { ...extensions, code };

    if (httpStatus !== undefined) {
      allExtensions.http = { status: httpStatus };
    }

    super(message, { extensions: allExtensions });
  }
}

/**
 * The request has no valid authentication.
 * Pass `{ httpStatus: HTTP_STATUS.UNAUTHORIZED }` only from request-level code (context.js).
 */
export class UnauthenticatedError extends AppError {
  constructor(message = DEFAULT_MESSAGES.UNAUTHENTICATED, { httpStatus } = {}) {
    super(message, ERROR_CODES.UNAUTHENTICATED, { httpStatus });
  }
}

/** The caller is authenticated but not allowed to perform the action. */
export class ForbiddenError extends AppError {
  constructor(message = DEFAULT_MESSAGES.FORBIDDEN) {
    super(message, ERROR_CODES.FORBIDDEN);
  }
}

/** The record does not exist, or the caller must not learn that it exists. */
export class NotFoundError extends AppError {
  constructor(message = DEFAULT_MESSAGES.NOT_FOUND) {
    super(message, ERROR_CODES.NOT_FOUND);
  }
}

/**
 * Client input failed validation.
 * `fieldErrors` is exposed as `extensions.fieldErrors`, an array of `{ path, message }`,
 * where `path` is the dot-joined input path (for example "input.rent").
 */
export class BadUserInputError extends AppError {
  constructor(message = DEFAULT_MESSAGES.BAD_USER_INPUT, { fieldErrors } = {}) {
    const extensions = {};

    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
      extensions.fieldErrors = fieldErrors.map(
        ({ path, message: fieldMessage }) => ({
          path: String(path),
          message: String(fieldMessage),
        }),
      );
    }

    super(message, ERROR_CODES.BAD_USER_INPUT, { extensions });
  }
}

/** The request conflicts with existing data, such as a duplicate or dependent records. */
export class ConflictError extends AppError {
  constructor(message = DEFAULT_MESSAGES.CONFLICT) {
    super(message, ERROR_CODES.CONFLICT);
  }
}

/**
 * Maps a known Prisma error to a client-safe error class.
 * P2002 (unique violation) becomes ConflictError, P2003 (foreign key violation) becomes
 * ConflictError and P2025 (record not found) becomes NotFoundError. Any other error is
 * returned unchanged so Yoga masks it. Never throws.
 * @param {unknown} error
 * @returns {unknown} the mapped error, or the original error
 */
export function mapPrismaError(error) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return error;
  }

  switch (error.code) {
    case PRISMA_ERROR_CODES.UNIQUE_VIOLATION:
      return new ConflictError(PRISMA_ERROR_MESSAGES.UNIQUE_VIOLATION);
    case PRISMA_ERROR_CODES.FOREIGN_KEY_VIOLATION:
      return new ConflictError(PRISMA_ERROR_MESSAGES.FOREIGN_KEY_VIOLATION);
    case PRISMA_ERROR_CODES.RECORD_NOT_FOUND:
      return new NotFoundError();
    default:
      return error;
  }
}

/** True when a Prisma error is a unique constraint violation (P2002). */
export function isUniqueViolation(error) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_ERROR_CODES.UNIQUE_VIOLATION
  );
}

/** True when a Prisma error means a required record was not found (P2025). */
export function isRecordNotFound(error) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === PRISMA_ERROR_CODES.RECORD_NOT_FOUND
  );
}
