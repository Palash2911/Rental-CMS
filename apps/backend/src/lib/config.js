import { z } from "zod";

const NODE_ENVS = Object.freeze({
  DEVELOPMENT: "development",
  PRODUCTION: "production",
  TEST: "test",
});

const DEFAULT_PORT = 9000;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const POSTGRES_PROTOCOL = /^postgres(ql)?$/;
const HTTP_PROTOCOL = /^https?$/;
const STRIPE_SECRET_KEY_PATTERN = /^(sk|rk)_(test|live)_\S+$/;
const STRIPE_LIVE_KEY_PATTERN = /^(sk|rk)_live_/;
const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_\S+$/;
const REDIS_PROTOCOL = /^rediss?$/;
const BOOLEAN_FLAGS = Object.freeze({ TRUE: "true", FALSE: "false" });
// S3 naming rules (3 to 63 characters of lowercase letters, digits, dots and hyphens,
// starting and ending with a letter or digit), which R2 and other providers also accept.
const S3_BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_REGION_PATTERN = /^[a-z0-9-]{1,32}$/;
const S3_CREDENTIAL_MAX_LENGTH = 256;

const VARIABLE_NAMES = Object.freeze([
  "NODE_ENV",
  "PORT",
  "DATABASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CHECKOUT_SUCCESS_URL",
  "STRIPE_CHECKOUT_CANCEL_URL",
  "STRIPE_PORTAL_RETURN_URL",
  "REDIS_URL",
  "TRUST_PROXY",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_BUCKET",
]);

const REQUIREMENTS = Object.freeze({
  NODE_ENV: `must be one of ${Object.values(NODE_ENVS).join(", ")}`,
  PORT: `must be an integer from ${MIN_PORT} to ${MAX_PORT}`,
  DATABASE_URL: "must be a postgres:// or postgresql:// URL",
  GOOGLE_APPLICATION_CREDENTIALS: "must be a file path",
  FIREBASE_SERVICE_ACCOUNT_JSON: "must be a JSON string",
  FIREBASE_AUTH_EMULATOR_HOST: "must be a host:port string",
  STRIPE_SECRET_KEY: "must be a Stripe secret or restricted key (sk_ or rk_)",
  STRIPE_WEBHOOK_SECRET: "must be a Stripe webhook signing secret (whsec_)",
  STRIPE_CHECKOUT_SUCCESS_URL: "must be an http:// or https:// URL",
  STRIPE_CHECKOUT_CANCEL_URL: "must be an http:// or https:// URL",
  STRIPE_PORTAL_RETURN_URL: "must be an http:// or https:// URL",
  REDIS_URL: "must be a redis:// or rediss:// URL",
  TRUST_PROXY: `must be "${BOOLEAN_FLAGS.TRUE}" or "${BOOLEAN_FLAGS.FALSE}"`,
  S3_ENDPOINT: "must be an http:// or https:// URL",
  S3_REGION: "must be a region name of lowercase letters, digits and hyphens, such as auto",
  S3_ACCESS_KEY_ID: `must be 1 to ${S3_CREDENTIAL_MAX_LENGTH} characters`,
  S3_SECRET_ACCESS_KEY: `must be 1 to ${S3_CREDENTIAL_MAX_LENGTH} characters`,
  S3_BUCKET: "must be a valid bucket name (3 to 63 lowercase letters, digits, dots or hyphens)",
});

const MISSING_REASON = "is required";
const FIREBASE_CREDENTIAL_NAMES =
  "GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_SERVICE_ACCOUNT_JSON";

const envSchema = z.object({
  NODE_ENV: z.enum(Object.values(NODE_ENVS)),
  PORT: z.coerce
    .number()
    .int()
    .min(MIN_PORT)
    .max(MAX_PORT)
    .default(DEFAULT_PORT),
  DATABASE_URL: z.url({ protocol: POSTGRES_PROTOCOL }),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),
  FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().regex(STRIPE_SECRET_KEY_PATTERN),
  STRIPE_WEBHOOK_SECRET: z.string().regex(STRIPE_WEBHOOK_SECRET_PATTERN),
  STRIPE_CHECKOUT_SUCCESS_URL: z.url({ protocol: HTTP_PROTOCOL }),
  STRIPE_CHECKOUT_CANCEL_URL: z.url({ protocol: HTTP_PROTOCOL }),
  STRIPE_PORTAL_RETURN_URL: z.url({ protocol: HTTP_PROTOCOL }),
  REDIS_URL: z.url({ protocol: REDIS_PROTOCOL }),
  TRUST_PROXY: z.enum(Object.values(BOOLEAN_FLAGS)).default(BOOLEAN_FLAGS.FALSE),
  S3_ENDPOINT: z.url({ protocol: HTTP_PROTOCOL }),
  S3_REGION: z.string().regex(S3_REGION_PATTERN),
  S3_ACCESS_KEY_ID: z.string().min(1).max(S3_CREDENTIAL_MAX_LENGTH),
  S3_SECRET_ACCESS_KEY: z.string().min(1).max(S3_CREDENTIAL_MAX_LENGTH),
  S3_BUCKET: z.string().regex(S3_BUCKET_PATTERN),
});

// Blank entries such as `PORT=` in an env file count as unset.
function readEnvironment(source) {
  return Object.fromEntries(
    VARIABLE_NAMES.map((name) => {
      const value = source[name];
      return [name, value === "" ? undefined : value];
    }),
  );
}

function schemaProblems(issues, rawEnv) {
  return issues.map((issue) => {
    const name = String(issue.path[0]);
    const reason =
      rawEnv[name] === undefined ? MISSING_REASON : REQUIREMENTS[name];
    return `${name} ${reason}`;
  });
}

function credentialProblems(rawEnv) {
  const hasFile = rawEnv.GOOGLE_APPLICATION_CREDENTIALS !== undefined;
  const hasInline = rawEnv.FIREBASE_SERVICE_ACCOUNT_JSON !== undefined;

  if (hasFile && hasInline) {
    return [`${FIREBASE_CREDENTIAL_NAMES}: set only one, not both`];
  }

  if (!hasFile && !hasInline) {
    return [`${FIREBASE_CREDENTIAL_NAMES}: exactly one is required`];
  }

  return [];
}

// With FIREBASE_AUTH_EMULATOR_HOST set, firebase-admin accepts unsigned ID tokens,
// so outside development anyone could forge any user or claim.
function emulatorProblems(rawEnv) {
  const emulatorSet = rawEnv.FIREBASE_AUTH_EMULATOR_HOST !== undefined;

  if (emulatorSet && rawEnv.NODE_ENV !== NODE_ENVS.DEVELOPMENT) {
    return [
      "FIREBASE_AUTH_EMULATOR_HOST must not be set unless NODE_ENV is development",
    ];
  }

  return [];
}

// A live key outside production would charge real cards from a dev machine or the test suite.
function stripeKeyProblems(rawEnv) {
  const key = rawEnv.STRIPE_SECRET_KEY;

  if (
    typeof key === "string" &&
    STRIPE_LIVE_KEY_PATTERN.test(key) &&
    rawEnv.NODE_ENV !== NODE_ENVS.PRODUCTION
  ) {
    return ["STRIPE_SECRET_KEY must be a test-mode key unless NODE_ENV is production"];
  }

  return [];
}

/**
 * Validates an environment object (shaped like process.env) and returns the frozen config.
 * Throws an Error listing each failing variable by name and reason, never its value.
 */
export function parseConfig(source) {
  const rawEnv = readEnvironment(source);
  const result = envSchema.safeParse(rawEnv);

  const problems = [
    ...(result.success ? [] : schemaProblems(result.error.issues, rawEnv)),
    ...credentialProblems(rawEnv),
    ...emulatorProblems(rawEnv),
    ...stripeKeyProblems(rawEnv),
  ];

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment configuration:\n- ${[...new Set(problems)].join("\n- ")}`,
    );
  }

  const env = result.data;

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    isDevelopment: env.NODE_ENV === NODE_ENVS.DEVELOPMENT,
    isProduction: env.NODE_ENV === NODE_ENVS.PRODUCTION,
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    googleApplicationCredentials: env.GOOGLE_APPLICATION_CREDENTIALS,
    firebaseServiceAccountJson: env.FIREBASE_SERVICE_ACCOUNT_JSON,
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
    stripeCheckoutSuccessUrl: env.STRIPE_CHECKOUT_SUCCESS_URL,
    stripeCheckoutCancelUrl: env.STRIPE_CHECKOUT_CANCEL_URL,
    stripePortalReturnUrl: env.STRIPE_PORTAL_RETURN_URL,
    redisUrl: env.REDIS_URL,
    trustProxy: env.TRUST_PROXY === BOOLEAN_FLAGS.TRUE,
    s3: Object.freeze({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      bucket: env.S3_BUCKET,
    }),
  });
}

/** Validated environment config. Holds secrets: never log it. */
export const config = parseConfig(process.env);
