import { HTTP_STATUS, UnauthenticatedError } from "../lib/errors.js";

const BEARER_PREFIX = /^Bearer\s+/i;

// Headers trims surrounding whitespace from values, so "Bearer " with no token
// arrives as just "Bearer" and must be matched on its own.
const BEARER_ONLY = /^Bearer$/i;

function unauthenticated(message) {
  return new UnauthenticatedError(message, {
    httpStatus: HTTP_STATUS.UNAUTHORIZED,
  });
}

function assertDependencies({ prisma, verifyIdToken, hasLiveSuperAdminClaim }) {
  if (prisma === null || typeof prisma !== "object") {
    throw new TypeError("createContextFactory requires a prisma client.");
  }

  if (typeof verifyIdToken !== "function") {
    throw new TypeError(
      "createContextFactory requires a verifyIdToken function.",
    );
  }

  if (typeof hasLiveSuperAdminClaim !== "function") {
    throw new TypeError(
      "createContextFactory requires a hasLiveSuperAdminClaim function.",
    );
  }
}

/**
 * Returns the createContext function Yoga calls per request. Dependencies are
 * injected so the context can be built without Firebase. verifyIdToken must throw
 * UnauthenticatedError (HTTP 401) for a bad token and rethrow anything else.
 * Throws TypeError immediately if a dependency is missing or invalid.
 */
export function createContextFactory(dependencies) {
  assertDependencies(dependencies ?? {});
  const { prisma, verifyIdToken, hasLiveSuperAdminClaim } = dependencies;

  /**
   * Builds the per-request GraphQL context from the Authorization header.
   * Throws UnauthenticatedError (HTTP 401) for a malformed header or an invalid,
   * expired or revoked token. Any other verification failure, such as Firebase
   * being unreachable, is rethrown unchanged so Yoga masks it as a server error.
   */
  return async function createContext({ request }) {
    const authHeader = request.headers.get("authorization");

    let userId = null;
    let email = null;
    let emailVerified = false;
    let name = null;
    let isSuperAdmin = false;

    if (authHeader) {
      if (BEARER_ONLY.test(authHeader)) {
        throw unauthenticated("Missing bearer token.");
      }

      if (!BEARER_PREFIX.test(authHeader)) {
        throw unauthenticated(
          "Authorization header must use the Bearer scheme.",
        );
      }

      const token = authHeader.replace(BEARER_PREFIX, "").trim();

      if (!token) {
        throw unauthenticated("Missing bearer token.");
      }

      const decoded = await verifyIdToken(token);
      userId = decoded.uid;
      email = decoded.email ?? null;
      emailVerified = decoded.email_verified === true;
      name =
        typeof decoded.name === "string" && decoded.name ? decoded.name : null;
      isSuperAdmin = decoded.superAdmin === true;
    }

    return {
      prisma,
      userId,
      email,
      emailVerified,
      name,
      isSuperAdmin,
      hasLiveSuperAdminClaim,
    };
  };
}
