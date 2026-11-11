import assert from "node:assert/strict";

import { graphql } from "graphql";

import { schema } from "../../src/graphql/rootSchema.js";

/**
 * Runs an operation in-process against the real schema: parse, validate and execute,
 * with `context` as the request context. No HTTP, no token verification.
 */
export function run(context, source, variableValues = {}) {
  return graphql({ schema, source, contextValue: context, variableValues });
}

function describeErrors(errors) {
  return JSON.stringify(
    errors.map((error) => ({ message: error.message, code: error.extensions?.code, path: error.path })),
  );
}

/** Asserts the result has no errors and returns its data. */
export function expectData(result) {
  if (result.errors?.length) {
    assert.fail(`Expected no errors, got ${describeErrors(result.errors)}`);
  }

  return result.data;
}

/**
 * Asserts the first error has `code` (and `message`, when given) and returns it.
 * An error with no code is an unmapped or masked error, which always fails the assertion.
 */
export function expectError(result, code, message) {
  assert.ok(result.errors?.length, `Expected a ${code} error, got data ${JSON.stringify(result.data)}`);

  const [error] = result.errors;
  assert.equal(error.extensions?.code, code, `Unexpected errors: ${describeErrors(result.errors)}`);

  if (message !== undefined) {
    assert.equal(error.message, message);
  }

  return error;
}
