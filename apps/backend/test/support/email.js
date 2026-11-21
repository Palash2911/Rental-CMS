import { EmailDeliveryError } from "../../src/email/gateway.js";

/**
 * A notifier that records what would be queued, in order, with no Redis. `emails` holds the
 * `{ type, key, data }` entries; `ofType(type)` filters them.
 */
export function recordingNotifier() {
  const emails = [];

  return {
    emails,
    ofType(type) {
      return emails.filter((email) => email.type === type);
    },
    async enqueue(batch) {
      emails.push(...batch.map((email) => ({ ...email, data: { ...email.data } })));
    },
  };
}

/**
 * An email gateway that records each send and answers from `responses`, consumed in order:
 * `"sent"`, `"alreadySent"`, or an EmailDeliveryError to throw. After the list runs out,
 * every send succeeds.
 */
export function fakeEmailGateway(responses = []) {
  const sent = [];
  const queue = [...responses];

  return {
    sent,
    gateway: Object.freeze({
      async send(message) {
        sent.push({ ...message });
        const next = queue.shift() ?? "sent";

        if (next instanceof EmailDeliveryError) {
          throw next;
        }

        return { id: `email_${sent.length}`, alreadySent: next === "alreadySent" };
      },
    }),
  };
}

/** A BullMQ-shaped job for the email processor: `name` is the type, `id` the key. */
export function emailJob({ type, key, data }, { timestamp = Date.now() } = {}) {
  return { name: type, id: key, data: JSON.parse(JSON.stringify(data)), timestamp };
}
