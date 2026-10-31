import { GraphQLError } from "graphql";

import { firebaseAuth } from "../firebase/admin.js";
import prisma from "../prisma.js";

const BEARER_PREFIX = /^Bearer\s+/i;

function unauthenticated(message) {
  return new GraphQLError(message, {
    extensions: {
      code: "UNAUTHENTICATED",
      http: { status: 401 },
    },
  });
}

export async function createContext({ request }) {
  const authHeader = request.headers.get("authorization");

  let userId = null;
  let email = null;
  let isSuperAdmin = false;

  if (authHeader) {
    if (!BEARER_PREFIX.test(authHeader)) {
      throw unauthenticated("Authorization header must use the Bearer scheme.");
    }

    const token = authHeader.replace(BEARER_PREFIX, "").trim();

    if (!token) {
      throw unauthenticated("Missing bearer token.");
    }

    try {
      const decoded = await firebaseAuth.verifyIdToken(token);
      userId = decoded.uid;
      email = decoded.email ?? null;
      isSuperAdmin = decoded.superAdmin === true;
    } catch (err) {
      console.warn(
        "Firebase token verification failed:",
        err?.code ?? err?.message,
      );
      throw unauthenticated("Invalid or expired token.");
    }
  }

  return {
    prisma,
    userId,
    email,
    isSuperAdmin,
  };
}
