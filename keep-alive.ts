/**
 * keep-alive.ts
 *
 * Run by the composite action with mode: keepalive, typically on a schedule.
 * Refreshes the persisted forum session so the ~60-day window never lapses:
 * restores the session cookie, lets the configured fallbacks (passkey →
 * email link → IMAP recovery) re-establish a session when it died, and
 * persists the resulting cookie back to secret CFX_SESSION_COOKIE.
 */
import { authenticateFromEnv } from "./src/session.ts";

async function main() {
  console.log("\n=== cfx session keep-alive ===\n");

  const browser = await authenticateFromEnv();
  await browser.close();

  console.log("\n=== Session alive & persisted ===\n");
}

main().catch((e) => {
  console.error("\nKeep-alive failed:", e);
  process.exit(1);
});
