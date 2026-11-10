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

const VARIABLE_NAMES = Object.freeze([
  "NODE_ENV",
  "PORT",
  "DATABASE_URL",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_SERVICE_ACCOUNT_JSON",
  "FIREBASE_AUTH_EMULATOR_HOST",
]);

const REQUIREMENTS = Object.freeze({
  NODE_ENV: `must be one of ${Object.values(NODE_ENVS).join(", ")}`,
  PORT: `must be an integer from ${MIN_PORT} to ${MAX_PORT}`,
  DATABASE_URL: "must be a postgres:// or postgresql:// URL",
  GOOGLE_APPLICATION_CREDENTIALS: "must be a file path",
  FIREBASE_SERVICE_ACCOUNT_JSON: "must be a JSON string",
  FIREBASE_AUTH_EMULATOR_HOST: "must be a host:port string",
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
});

// Blank entries such as `PORT=` in an env file count as unset.
function readEnvironment() {
  return Object.fromEntries(
    VARIABLE_NAMES.map((name) => {
      const value = process.env[name];
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

function loadConfig() {
  const rawEnv = readEnvironment();
  const result = envSchema.safeParse(rawEnv);

  const problems = [
    ...(result.success ? [] : schemaProblems(result.error.issues, rawEnv)),
    ...credentialProblems(rawEnv),
    ...emulatorProblems(rawEnv),
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
  });
}

/** Validated environment config. Holds secrets: never log it. */
export const config = loadConfig();
