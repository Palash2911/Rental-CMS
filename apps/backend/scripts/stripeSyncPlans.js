import { createStripeClient } from "../src/stripe/gateway.js";
import { assertTestModeKey, syncPlans } from "../src/stripe/syncPlans.js";

// Reads STRIPE_SECRET_KEY directly instead of lib/config.js, so the script needs no database
// or Firebase settings. The key value is never printed.
async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;

  try {
    assertTestModeKey(secretKey);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const results = await syncPlans(createStripeClient(secretKey));

  for (const { kind, key, result } of results) {
    console.info(`${kind} ${key}: ${result}`);
  }
}

main().catch((error) => {
  console.error(`Plan sync failed: ${error.message}`);
  process.exit(1);
});
