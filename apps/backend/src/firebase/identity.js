import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";

import { HTTP_STATUS, UnauthenticatedError } from "../lib/errors.js";
import { firebaseAuth } from "./admin.js";
import { isInvalidTokenError } from "./tokenErrors.js";

// A claim stays in the ID token until it expires (up to an hour), so the token alone
// would keep a revoked super admin's access. The live read makes revocation immediate.
export async function hasLiveSuperAdminClaim(uid) {
  try {
    const record = await firebaseAuth.getUser(uid);
    return record.customClaims?.superAdmin === true;
  } catch (error) {
    if (
      error instanceof FirebaseAuthError &&
      error.hasCode(AuthErrorCode.USER_NOT_FOUND)
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Verifies a Firebase ID token and returns the decoded token.
 * Throws UnauthenticatedError (HTTP 401) for an invalid, expired or revoked token.
 * Any other failure, such as Firebase being unreachable, is rethrown unchanged.
 */
export async function verifyIdToken(token) {
  try {
    return await firebaseAuth.verifyIdToken(token);
  } catch (error) {
    if (isInvalidTokenError(error)) {
      throw new UnauthenticatedError("Invalid or expired token.", {
        httpStatus: HTTP_STATUS.UNAUTHORIZED,
      });
    }

    throw error;
  }
}
