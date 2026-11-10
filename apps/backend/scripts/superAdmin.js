import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";
import { z } from "zod";

import { firebaseAuth } from "../src/firebase/admin.js";

const COMMANDS = Object.freeze({ GRANT: "grant", REVOKE: "revoke" });
const SUPER_ADMIN_CLAIM = "superAdmin";
const EXIT_CODES = Object.freeze({ SUCCESS: 0, FAILURE: 1 });

const MESSAGES = Object.freeze({
  USAGE:
    "Usage: yarn admin:grant-super-admin <email> | yarn admin:revoke-super-admin <email>",
  INVALID_EMAIL: "That is not a valid email address.",
  USER_NOT_FOUND: "No Firebase user has that email address.",
  UNVERIFIED: "Refusing to grant: this user's email address is not verified.",
  DISABLED: "Refusing to grant: this Firebase user is disabled.",
  ALREADY_GRANTED: "This user already has the superAdmin claim. Nothing changed.",
  NOT_GRANTED: "This user does not have the superAdmin claim. Nothing changed.",
  GRANTED: "Granted the superAdmin claim.",
  REVOKED:
    "Revoked the superAdmin claim and the user's refresh tokens. Admin operations are refused immediately.",
  REFRESH:
    "The user must sign out and sign in again (or force an ID token refresh) for this change to take effect in their token.",
});

const emailSchema = z.email();

async function findUser(email) {
  try {
    return await firebaseAuth.getUserByEmail(email);
  } catch (error) {
    if (
      error instanceof FirebaseAuthError &&
      error.hasCode(AuthErrorCode.USER_NOT_FOUND)
    ) {
      return null;
    }

    throw error;
  }
}

async function grant(user) {
  const claims = user.customClaims ?? {};

  if (claims[SUPER_ADMIN_CLAIM] === true) {
    return MESSAGES.ALREADY_GRANTED;
  }

  if (!user.emailVerified) {
    throw new Error(MESSAGES.UNVERIFIED);
  }

  if (user.disabled) {
    throw new Error(MESSAGES.DISABLED);
  }

  await firebaseAuth.setCustomUserClaims(user.uid, {
    ...claims,
    [SUPER_ADMIN_CLAIM]: true,
  });

  return `${MESSAGES.GRANTED} ${MESSAGES.REFRESH}`;
}

async function revoke(user) {
  const { [SUPER_ADMIN_CLAIM]: current, ...otherClaims } =
    user.customClaims ?? {};

  if (current === undefined) {
    return MESSAGES.NOT_GRANTED;
  }

  await firebaseAuth.setCustomUserClaims(user.uid, otherClaims);
  await firebaseAuth.revokeRefreshTokens(user.uid);

  return `${MESSAGES.REVOKED} ${MESSAGES.REFRESH}`;
}

const HANDLERS = Object.freeze({
  [COMMANDS.GRANT]: grant,
  [COMMANDS.REVOKE]: revoke,
});

async function run([command, rawEmail]) {
  const handler = HANDLERS[command];

  if (!handler || !rawEmail) {
    throw new Error(MESSAGES.USAGE);
  }

  const parsed = emailSchema.safeParse(rawEmail.trim());

  if (!parsed.success) {
    throw new Error(MESSAGES.INVALID_EMAIL);
  }

  const user = await findUser(parsed.data);

  if (!user) {
    throw new Error(MESSAGES.USER_NOT_FOUND);
  }

  return handler(user);
}

try {
  console.info(await run(process.argv.slice(2)));
  process.exit(EXIT_CODES.SUCCESS);
} catch (error) {
  console.error(error.message);
  process.exit(EXIT_CODES.FAILURE);
}
