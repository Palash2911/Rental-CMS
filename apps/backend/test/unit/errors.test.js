import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GraphQLError } from "graphql";
import { maskError } from "graphql-yoga";

import { Prisma } from "../../src/generated/prisma/client.ts";
import {
  BadUserInputError,
  ConflictError,
  ERROR_CODES,
  ForbiddenError,
  HTTP_STATUS,
  isRecordNotFound,
  isUniqueViolation,
  mapPrismaError,
  NotFoundError,
  UnauthenticatedError,
} from "../../src/lib/errors.js";

const MASKED_MESSAGE = "Unexpected error.";
const CLIENT_VERSION = "test";

function prismaError(code) {
  return new Prisma.PrismaClientKnownRequestError("database detail that must not leak", {
    code,
    clientVersion: CLIENT_VERSION,
  });
}

describe("error classes", () => {
  const cases = [
    [UnauthenticatedError, ERROR_CODES.UNAUTHENTICATED, "Authentication required."],
    [ForbiddenError, ERROR_CODES.FORBIDDEN, "You do not have permission to perform this action."],
    [NotFoundError, ERROR_CODES.NOT_FOUND, "Resource not found."],
    [BadUserInputError, ERROR_CODES.BAD_USER_INPUT, "Invalid input."],
    [ConflictError, ERROR_CODES.CONFLICT, "The request conflicts with the current state of the resource."],
  ];

  for (const [ErrorClass, code, defaultMessage] of cases) {
    it(`${ErrorClass.name} carries code ${code} and a safe default message`, () => {
      const error = new ErrorClass();

      assert.ok(error instanceof GraphQLError);
      assert.equal(error.extensions.code, code);
      assert.equal(error.message, defaultMessage);
      assert.equal(error.originalError, undefined);
      assert.equal(error.extensions.http, undefined);
    });

    it(`${ErrorClass.name} passes through Yoga masking unchanged`, () => {
      const error = new ErrorClass("A client-safe message.");
      const masked = maskError(error, MASKED_MESSAGE, false);

      assert.equal(masked, error);
    });
  }

  it("UnauthenticatedError sets an HTTP status only when asked", () => {
    const error = new UnauthenticatedError("Invalid or expired token.", {
      httpStatus: HTTP_STATUS.UNAUTHORIZED,
    });

    assert.deepEqual(error.extensions.http, { status: 401 });
  });

  it("BadUserInputError exposes fieldErrors as strings", () => {
    const error = new BadUserInputError(undefined, {
      fieldErrors: [{ path: 3, message: "Too long." }],
    });

    assert.deepEqual(error.extensions.fieldErrors, [{ path: "3", message: "Too long." }]);
  });

  it("BadUserInputError omits fieldErrors when there are none", () => {
    const error = new BadUserInputError(undefined, { fieldErrors: [] });

    assert.equal("fieldErrors" in error.extensions, false);
  });

  it("Yoga masks a plain Error as INTERNAL_SERVER_ERROR without its message", () => {
    const masked = maskError(new Error("secret internal detail"), MASKED_MESSAGE, false);

    assert.equal(masked.message, MASKED_MESSAGE);
    assert.equal(masked.extensions.code, ERROR_CODES.INTERNAL_SERVER_ERROR);
    assert.doesNotMatch(JSON.stringify(masked.toJSON()), /secret internal detail/);
  });
});

describe("mapPrismaError", () => {
  it("maps a unique violation (P2002) to CONFLICT without database detail", () => {
    const mapped = mapPrismaError(prismaError("P2002"));

    assert.ok(mapped instanceof ConflictError);
    assert.equal(mapped.message, "A record with these details already exists.");
  });

  it("maps a foreign key violation (P2003) to CONFLICT", () => {
    const mapped = mapPrismaError(prismaError("P2003"));

    assert.ok(mapped instanceof ConflictError);
    assert.equal(mapped.message, "This action conflicts with related records.");
  });

  it("maps a missing record (P2025) to NOT_FOUND", () => {
    assert.ok(mapPrismaError(prismaError("P2025")) instanceof NotFoundError);
  });

  it("returns other Prisma errors unchanged so they stay masked", () => {
    const error = prismaError("P2034");

    assert.equal(mapPrismaError(error), error);
  });

  it("returns non-Prisma errors unchanged", () => {
    const error = new TypeError("boom");

    assert.equal(mapPrismaError(error), error);
  });

  it("isUniqueViolation and isRecordNotFound match only their codes", () => {
    assert.equal(isUniqueViolation(prismaError("P2002")), true);
    assert.equal(isUniqueViolation(prismaError("P2025")), false);
    assert.equal(isRecordNotFound(prismaError("P2025")), true);
    assert.equal(isRecordNotFound(new Error("P2025")), false);
  });
});
