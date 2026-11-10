import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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

/**
 * Credential resolution order:
 * 1. FIREBASE_SERVICE_ACCOUNT_JSON: the full service account JSON as a string.
 *    Used on hosts where you can't ship a file (Lambda, Render, etc.).
 * 2. GOOGLE_APPLICATION_CREDENTIALS: path to the service account file.
 *    Used for local development.
 */
function resolveCredential() {
  const inlineJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  if (inlineJson) {
    return certFromInlineJson(inlineJson);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }

  throw new Error(
    "Firebase credentials missing. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON.",
  );
}

const app =
  getApps().length > 0
    ? getApp()
    : initializeApp({ credential: resolveCredential() });

export const firebaseAuth = getAuth(app);
