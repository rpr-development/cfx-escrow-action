/**
 * setup-passkey.ts  —  run: bun run setup-passkey
 *
 * Run this locally once to register a passkey and generate the GitHub Secrets
 * required by the deploy action.
 *
 * Based on https://github.com/ilovehugetits/9am-build — credits to the original authors.
 *
 * Steps:
 *   1. bun install                  (once, inside this directory)
 *   2. bun run setup-passkey        (opens a visible browser)
 *   3. Log in to the Cfx.re Forum
 *   4. Click 'Add passkey' on the security page
 *   5. Add passkey-credential.json as secret CFX_PASSKEY_CREDENTIAL
 *   6. Add auth-state.json as secret CFX_AUTH_STATE
 */
import puppeteer from "puppeteer";
import { writeFile } from "fs/promises";
import path from "path";
import { createInterface } from "readline";

import { setupVirtualAuthenticator, getRegisteredCredentials } from "./src/passkey.ts";

const FORUM_LOGIN_URL    = "https://forum.cfx.re/login";
const FORUM_SECURITY_URL = "https://forum.cfx.re/u/me/preferences/security";
const CREDENTIAL_FILE    = path.resolve(import.meta.dirname, "passkey-credential.json");
const AUTH_STATE_FILE    = path.resolve(import.meta.dirname, "auth-state.json");

function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

async function main() {
  console.log("\n=== Cfx.re Passkey Setup ===\n");

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--window-size=1280,800"],
  });

  const page = (await browser.pages())[0];

  console.log("Browser opened. Log in to the Cfx.re Forum...");
  await page.goto(FORUM_LOGIN_URL, { waitUntil: "load" });

  await waitForEnter("\nPress Enter once you are logged in...");

  // Activate virtual authenticator BEFORE the security page,
  // otherwise the browser won't intercept the WebAuthn challenge.
  const authenticatorId = await setupVirtualAuthenticator(page);
  console.log("Virtual authenticator active.");

  await page.goto(FORUM_SECURITY_URL, { waitUntil: "networkidle2" });
  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n────────────────────────────────────────");
  console.log("  Click 'Add passkey' in the browser.");
  console.log("  Give it a name (e.g. 'cfx-deploy').");
  console.log("  Confirm the registration.");
  console.log("────────────────────────────────────────\n");

  await waitForEnter("Press Enter once the passkey has been created...");

  const credentials = await getRegisteredCredentials(page, authenticatorId);

  if (credentials.length === 0) {
    console.error("\nNo passkey found. Did you click 'Add passkey' and confirm?");
    await browser.close();
    process.exit(1);
  }

  const credential = credentials[credentials.length - 1];
  await writeFile(CREDENTIAL_FILE, JSON.stringify(credential, null, 2), "utf-8");
  console.log(`\nPasskey saved → ${CREDENTIAL_FILE}`);

  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
  console.log(`Session saved → ${AUTH_STATE_FILE}`);

  await browser.close();

  console.log("\n=== Done! ===");
  console.log("Add the contents of these files as GitHub Secrets:");
  console.log("  CFX_PASSKEY_CREDENTIAL  ←  passkey-credential.json");
  console.log("  CFX_AUTH_STATE          ←  auth-state.json\n");
  console.log("GitHub CLI commands:");
  console.log("  gh secret set CFX_PASSKEY_CREDENTIAL --body \"$(cat passkey-credential.json)\"");
  console.log("  gh secret set CFX_AUTH_STATE         --body \"$(cat auth-state.json)\"\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
