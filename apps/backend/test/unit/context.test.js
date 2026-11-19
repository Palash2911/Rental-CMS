import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createContextFactory } from "../../src/graphql/context.js";
import {
  ERROR_CODES,
  HTTP_STATUS,
  UnauthenticatedError,
} from "../../src/lib/errors.js";

const PRISMA = Object.freeze({ name: "prisma stand-in" });

function hasLiveSuperAdminClaim() {
  return Promise.resolve(false);
}

function requestWith(authorization) {
  const headers = authorization === undefined ? {} : { authorization };
  return new Request("http://localhost/graphql", { headers });
}

function recordingVerifier(decoded = { uid: "uid-1" }) {
  const calls = [];
  const verify = async (token) => {
    calls.push(token);
    return decoded;
  };
  return { verify, calls };
}

function buildContext({ verifyIdToken, authorization }) {
  const createContext = createContextFactory({
    prisma: PRISMA,
    verifyIdToken,
    hasLiveSuperAdminClaim,
  });
  return createContext({ request: requestWith(authorization) });
}

function assertUnauthenticated401(error, message) {
  assert.ok(error instanceof UnauthenticatedError);
  assert.equal(error.extensions.code, ERROR_CODES.UNAUTHENTICATED);
  assert.equal(error.extensions.http?.status, HTTP_STATUS.UNAUTHORIZED);
  if (message !== undefined) {
    assert.equal(error.message, message);
  }
  return true;
}

describe("createContextFactory", () => {
  const valid = {
    prisma: PRISMA,
    verifyIdToken: async () => ({ uid: "uid-1" }),
    hasLiveSuperAdminClaim,
  };

  it("throws TypeError when called without dependencies", () => {
    assert.throws(() => createContextFactory(), TypeError);
  });

  for (const [field, value] of [
    ["prisma", undefined],
    ["prisma", null],
    ["prisma", "not a client"],
    ["verifyIdToken", undefined],
    ["verifyIdToken", "not a function"],
    ["hasLiveSuperAdminClaim", undefined],
    ["hasLiveSuperAdminClaim", {}],
  ]) {
    it(`throws TypeError when ${field} is ${value === null ? "null" : typeof value}`, () => {
      assert.throws(
        () => createContextFactory({ ...valid, [field]: value }),
        (error) => error instanceof TypeError && error.message.includes(field),
      );
    });
  }

  it("returns a function when every dependency is valid", () => {
    assert.equal(typeof createContextFactory(valid), "function");
  });
});

describe("createContext", () => {
  it("gives an anonymous context and never calls the verifier when there is no header", async () => {
    const { verify, calls } = recordingVerifier();

    const context = await buildContext({ verifyIdToken: verify });

    assert.equal(calls.length, 0);
    assert.deepEqual(
      { ...context, hasLiveSuperAdminClaim: undefined },
      {
        prisma: PRISMA,
        userId: null,
        email: null,
        emailVerified: false,
        name: null,
        isSuperAdmin: false,
        hasLiveSuperAdminClaim: undefined,
      },
    );
  });

  it("rejects a non-Bearer header with 401 without calling the verifier", async () => {
    const { verify, calls } = recordingVerifier();

    await assert.rejects(
      buildContext({ verifyIdToken: verify, authorization: "Basic abc123" }),
      (error) =>
        assertUnauthenticated401(
          error,
          "Authorization header must use the Bearer scheme.",
        ),
    );
    assert.equal(calls.length, 0);
  });

  it("accepts a lowercase bearer scheme and passes the trimmed token", async () => {
    const { verify, calls } = recordingVerifier();

    const context = await buildContext({
      verifyIdToken: verify,
      authorization: "bearer   token-abc  ",
    });

    assert.deepEqual(calls, ["token-abc"]);
    assert.equal(context.userId, "uid-1");
  });

  for (const authorization of ["Bearer    ", "Bearer", "bearer", "BEARER", "Bearer  "]) {
    it(`rejects ${JSON.stringify(authorization)} as a missing token with 401 without calling the verifier`, async () => {
      const { verify, calls } = recordingVerifier();

      await assert.rejects(
        buildContext({ verifyIdToken: verify, authorization }),
        (error) => assertUnauthenticated401(error, "Missing bearer token."),
      );
      assert.equal(calls.length, 0);
    });
  }

  it("rejects a scheme that only starts with Bearer as a non-Bearer header", async () => {
    const { verify, calls } = recordingVerifier();

    await assert.rejects(
      buildContext({ verifyIdToken: verify, authorization: "Bearertoken-abc" }),
      (error) =>
        assertUnauthenticated401(
          error,
          "Authorization header must use the Bearer scheme.",
        ),
    );
    assert.equal(calls.length, 0);
  });

  it("propagates the verifier's UnauthenticatedError with HTTP 401", async () => {
    const thrown = new UnauthenticatedError("Invalid or expired token.", {
      httpStatus: HTTP_STATUS.UNAUTHORIZED,
    });

    await assert.rejects(
      buildContext({
        verifyIdToken: async () => {
          throw thrown;
        },
        authorization: "Bearer token-abc",
      }),
      (error) => {
        assert.equal(error, thrown);
        return assertUnauthenticated401(error, "Invalid or expired token.");
      },
    );
  });

  it("rethrows any other verifier error unchanged", async () => {
    const outage = new Error("Firebase unreachable");

    await assert.rejects(
      buildContext({
        verifyIdToken: async () => {
          throw outage;
        },
        authorization: "Bearer token-abc",
      }),
      (error) => error === outage,
    );
  });

  it("maps every claim from a fully populated token", async () => {
    const { verify } = recordingVerifier({
      uid: "uid-1",
      email: "owner@example.com",
      email_verified: true,
      name: "Owner One",
      superAdmin: true,
    });

    const context = await buildContext({
      verifyIdToken: verify,
      authorization: "Bearer token-abc",
    });

    assert.equal(context.prisma, PRISMA);
    assert.equal(context.userId, "uid-1");
    assert.equal(context.email, "owner@example.com");
    assert.equal(context.emailVerified, true);
    assert.equal(context.name, "Owner One");
    assert.equal(context.isSuperAdmin, true);
  });

  it("sets email to null when the token has no email", async () => {
    const { verify } = recordingVerifier({ uid: "uid-1" });

    const context = await buildContext({
      verifyIdToken: verify,
      authorization: "Bearer token-abc",
    });

    assert.equal(context.email, null);
  });

  for (const value of ["true", 1, false, undefined]) {
    it(`sets emailVerified to false when email_verified is ${JSON.stringify(value) ?? "undefined"}`, async () => {
      const { verify } = recordingVerifier({ uid: "uid-1", email_verified: value });

      const context = await buildContext({
        verifyIdToken: verify,
        authorization: "Bearer token-abc",
      });

      assert.equal(context.emailVerified, false);
    });

    it(`sets isSuperAdmin to false when superAdmin is ${JSON.stringify(value) ?? "undefined"}`, async () => {
      const { verify } = recordingVerifier({ uid: "uid-1", superAdmin: value });

      const context = await buildContext({
        verifyIdToken: verify,
        authorization: "Bearer token-abc",
      });

      assert.equal(context.isSuperAdmin, false);
    });
  }

  for (const value of ["", 42, null, undefined, ["Owner"]]) {
    it(`sets name to null when name is ${JSON.stringify(value) ?? "undefined"}`, async () => {
      const { verify } = recordingVerifier({ uid: "uid-1", name: value });

      const context = await buildContext({
        verifyIdToken: verify,
        authorization: "Bearer token-abc",
      });

      assert.equal(context.name, null);
    });
  }

  it("puts the injected hasLiveSuperAdminClaim on the context, signed in or anonymous", async () => {
    const { verify } = recordingVerifier();

    const anonymous = await buildContext({ verifyIdToken: verify });
    const signedIn = await buildContext({
      verifyIdToken: verify,
      authorization: "Bearer token-abc",
    });

    assert.equal(anonymous.hasLiveSuperAdminClaim, hasLiveSuperAdminClaim);
    assert.equal(signedIn.hasLiveSuperAdminClaim, hasLiveSuperAdminClaim);
  });
});
