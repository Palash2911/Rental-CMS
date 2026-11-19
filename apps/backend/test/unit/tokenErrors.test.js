import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { getApps } from "firebase-admin/app";
import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";

import { isInvalidTokenError } from "../../src/firebase/tokenErrors.js";

function authError(code, message = "detail") {
  return new FirebaseAuthError({ code, message });
}

describe("isInvalidTokenError", () => {
  it("does not initialise a Firebase app when imported", () => {
    assert.equal(getApps().length, 0);
  });

  for (const code of [
    AuthErrorCode.ID_TOKEN_EXPIRED,
    AuthErrorCode.ID_TOKEN_REVOKED,
    AuthErrorCode.USER_DISABLED,
  ]) {
    it(`treats ${code} as an invalid token`, () => {
      assert.equal(isInvalidTokenError(authError(code)), true);
    });
  }

  it("treats a plain argument error as an invalid token", () => {
    const error = authError(
      AuthErrorCode.INVALID_ARGUMENT,
      "Decoding Firebase ID token failed.",
    );
    assert.equal(isInvalidTokenError(error), true);
  });

  for (const message of [
    "Error fetching public keys for Google certs: invalid_grant",
    "Error while making request: getaddrinfo ENOTFOUND www.googleapis.com.",
  ]) {
    it(`treats an argument error starting "${message.split(":")[0]}" as an outage`, () => {
      const error = authError(AuthErrorCode.INVALID_ARGUMENT, message);
      assert.equal(isInvalidTokenError(error), false);
    });
  }

  it("treats an internal error as an outage", () => {
    assert.equal(isInvalidTokenError(authError(AuthErrorCode.INTERNAL_ERROR)), false);
  });

  for (const [label, error] of [
    ["a plain Error", new Error("Firebase unreachable")],
    ["a TypeError", new TypeError("bad")],
    ["an object mimicking a Firebase error", { code: "auth/id-token-expired", hasCode: () => true }],
    ["null", null],
    ["undefined", undefined],
  ]) {
    it(`returns false for ${label}`, () => {
      assert.equal(isInvalidTokenError(error), false);
    });
  }
});
