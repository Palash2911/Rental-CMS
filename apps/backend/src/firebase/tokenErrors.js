import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";

const INVALID_TOKEN_CODES = Object.freeze([
  AuthErrorCode.ID_TOKEN_EXPIRED,
  AuthErrorCode.ID_TOKEN_REVOKED,
  AuthErrorCode.USER_DISABLED,
]);

// Depends on firebase-admin 14.5.0 internal error wording; if it changes, outages fail safe to 401.
const KEY_FETCH_FAILURE_PREFIXES = Object.freeze([
  "Error fetching public keys for Google certs",
  "Error while making request",
]);

function isKeyFetchFailure(error) {
  const message = typeof error.message === "string" ? error.message : "";
  return KEY_FETCH_FAILURE_PREFIXES.some((prefix) =>
    message.startsWith(prefix),
  );
}

/**
 * True when a token verification error means the token itself is bad (expired,
 * revoked, disabled user or malformed), so the request should get a 401.
 * False for anything else, such as a key fetch outage, which must surface as a 500.
 */
export function isInvalidTokenError(error) {
  if (!(error instanceof FirebaseAuthError)) {
    return false;
  }

  if (INVALID_TOKEN_CODES.some((code) => error.hasCode(code))) {
    return true;
  }

  return (
    error.hasCode(AuthErrorCode.INVALID_ARGUMENT) && !isKeyFetchFailure(error)
  );
}
