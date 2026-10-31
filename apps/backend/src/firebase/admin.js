import {
  applicationDefault,
  cert,
  getApp,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

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
    try {
      return cert(JSON.parse(inlineJson));
    } catch {
      throw new Error(
        "FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON.",
      );
    }
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
