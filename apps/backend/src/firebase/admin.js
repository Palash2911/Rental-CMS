import {
  cert,
  FirebaseAppError,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { config } from "../lib/config.js";

const CREDENTIAL_FILE_ERROR_PREFIX =
  "GOOGLE_APPLICATION_CREDENTIALS points to a file that";

// The JSON.parse error is never included: Node's SyntaxError message quotes part
// of the input, which would leak the secret. firebase-admin's own validation
// messages only name the missing or invalid field, so they are safe to include.
function certFromInlineJson(inlineJson) {
  let serviceAccount;

  try {
    serviceAccount = JSON.parse(inlineJson);
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.",
    );
  }

  try {
    return cert(serviceAccount);
  } catch (error) {
    throw new Error(
      `FIREBASE_SERVICE_ACCOUNT_JSON is valid JSON but not a valid service account: ${error.message}`,
    );
  }
}

// cert(path) wraps a JSON.parse failure in a message that quotes the file's content,
// so only the cause's type, fs error code or firebase-admin's own message is reported.
function describeCredentialFileError(cause) {
  if (cause instanceof SyntaxError) {
    return `${CREDENTIAL_FILE_ERROR_PREFIX} is not valid JSON.`;
  }

  if (cause instanceof FirebaseAppError) {
    return `${CREDENTIAL_FILE_ERROR_PREFIX} is not a valid service account: ${cause.message}`;
  }

  if (typeof cause?.code === "string") {
    return `${CREDENTIAL_FILE_ERROR_PREFIX} cannot be read (${cause.code}).`;
  }

  return `${CREDENTIAL_FILE_ERROR_PREFIX} is not a valid service account.`;
}

function certFromFile(path) {
  try {
    return cert(path);
  } catch (error) {
    throw new Error(describeCredentialFileError(error?.cause));
  }
}

/**
 * Credentials: exactly one is set, enforced by lib/config.js.
 * - FIREBASE_SERVICE_ACCOUNT_JSON: the full service account JSON as a string.
 *   Used on hosts where you can't ship a file (Lambda, Render, etc.).
 * - GOOGLE_APPLICATION_CREDENTIALS: path to the service account file.
 *   Used for local development.
 */
function resolveCredential() {
  if (config.firebaseServiceAccountJson) {
    return certFromInlineJson(config.firebaseServiceAccountJson);
  }

  return certFromFile(config.googleApplicationCredentials);
}

const app =
  getApps().length > 0
    ? getApp()
    : initializeApp({ credential: resolveCredential() });

export const firebaseAuth = getAuth(app);
