import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";

import { firebaseAuth } from "../firebase/admin.js";
import { HTTP_STATUS, UnauthenticatedError } from "../lib/errors.js";
import prisma from "../prisma.js";

const BEARER_PREFIX = /^Bearer\s+/i;

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

function unauthenticated(message) {
  return new UnauthenticatedError(message, {
    httpStatus: HTTP_STATUS.UNAUTHORIZED,
  });
}

function isKeyFetchFailure(error) {
  const message = typeof error.message === "string" ? error.message : "";
  return KEY_FETCH_FAILURE_PREFIXES.some((prefix) =>
    message.startsWith(prefix),
  );
}

function isInvalidTokenError(error) {
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

async function verifyToken(token) {
  try {
    return await firebaseAuth.verifyIdToken(token);
  } catch (error) {
    if (isInvalidTokenError(error)) {
      throw unauthenticated("Invalid or expired token.");
    }

    throw error;
  }
}

/**
 * Builds the per-request GraphQL context from the Authorization header.
 * Throws UnauthenticatedError (HTTP 401) for a malformed header or an invalid,
 * expired or revoked token. Any other verification failure, such as Firebase
 * being unreachable, is rethrown unchanged so Yoga masks it as a server error.
 */
export async function createContext({ request }) {
  const authHeader = request.headers.get("authorization");

  let userId = null;
  let email = null;
  let emailVerified = false;
  let name = null;
  let isSuperAdmin = false;

  if (authHeader) {
    if (!BEARER_PREFIX.test(authHeader)) {
      throw unauthenticated("Authorization header must use the Bearer scheme.");
    }

    const token = authHeader.replace(BEARER_PREFIX, "").trim();

    if (!token) {
      throw unauthenticated("Missing bearer token.");
    }

    const decoded = await verifyToken(token);
    userId = decoded.uid;
    email = decoded.email ?? null;
    emailVerified = decoded.email_verified === true;
    name = typeof decoded.name === "string" && decoded.name ? decoded.name : null;
    isSuperAdmin = decoded.superAdmin === true;
  }

  return {
    prisma,
    userId,
    email,
    emailVerified,
    name,
    isSuperAdmin,
  };
}
