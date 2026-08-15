/**
 * Based on https://github.com/ilovehugetits/9am-build — credits to the original authors.
 * Modified: removed chalk dependency; session persistence goes through a GitHub
 * secret (CFX_SESSION_COOKIE) instead of an on-disk cookie cache.
 */
import puppeteer, { type Browser } from "puppeteer";
import { setupVirtualAuthenticator, loadCredential } from "./passkey.js";
import { generateTotp } from "./totp.js";
import { waitForLoginLink, type ImapCredentials } from "./mail.js";

const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

/** Thrown when the forum refuses the login because of a new device/location. */
export class NewLocationBlockError extends Error {
  constructor() {
    super(
      "Cfx forum blocked this login from a new device/location and emailed a one-time " +
      "login link to the account's email address.\n" +
      "Fix: open the NEWEST 'Log in via link' email (every blocked attempt sends a new one " +
      "and invalidates older links), copy the https://forum.cfx.re/session/email-login/... URL " +
      "and store it as a repository variable, then re-run this workflow:\n" +
      '  gh variable set CFX_EMAIL_LOGIN_URL --body "<link>" --repo <owner>/<repo>\n' +
      "If the account has 2FA enabled, secret CFX_TOTP_SECRET (the authenticator's base32 " +
      "secret) must also be set to complete the email login.\n" +
      "After a successful run the forum session is persisted (secret CFX_SESSION_COOKIE, " +
      "requires github_pat) so later runs skip the login entirely."
    );
    this.name = "NewLocationBlockError";
  }
}

async function isNewLocationBlocked(page: import("puppeteer").Page): Promise<boolean> {
  return page.evaluate(() =>
    document.body.innerText.includes("new device or location")
  ).catch(() => false);
}

async function waitForPortalLoaded(page: import("puppeteer").Page, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hasCreatedAssets = await page.evaluate(() =>
      document.body.innerText.includes("Created Assets")
    ).catch(() => false);
    if (hasCreatedAssets) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Portal failed to load (timeout), last URL: ${page.url()}`);
}

async function clickLoginButton(page: import("puppeteer").Page): Promise<void> {
  await page.waitForSelector('button[class*="login_noWrap"]', { timeout: 10_000 });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }),
    page.evaluate(() => {
      const btn = document.querySelector('button[class*="login_noWrap"]') as HTMLElement | null;
      btn?.click();
    }),
  ]);
}

// Forum session established → portal SSO: goto portal → Next.js redirects to /login
// client-side (URL keeps showing assets/created-assets) → click sign in → sso_provider
// redirects to portal.cfx.re/authenticate?sso=... → portal logged in
async function finishPortalSso(page: import("puppeteer").Page): Promise<void> {
  await page.goto(PORTAL_URL, { waitUntil: "load" });
  console.log(`[auth] after goto portal: ${page.url()}`);

  const loginBtn = await page.waitForSelector('button[class*="login_noWrap"]', { timeout: 15_000 }).catch(() => null);
  if (loginBtn) {
    console.log("[auth] login button found, sign in click...");
    await clickLoginButton(page);
    console.log(`[auth] after sign in click: ${page.url()}`);
  } else {
    console.log("[auth] no login button — possibly already logged in on portal");
  }

  await waitForPortalLoaded(page, 30_000);
}

// Restoring a session via the long-lived Discourse "_t" cookie is not a login,
// so it bypasses the new-device/location check entirely.
async function loginWithSessionCookie(browser: Browser, tCookie: string): Promise<boolean> {
  console.log("Attempting session cookie login...");

  const page = (await browser.pages())[0];

  try {
    await browser.defaultBrowserContext().setCookie({
      name: "_t",
      value: tCookie,
      domain: "forum.cfx.re",
      path: "/",
      httpOnly: true,
      secure: true,
    });

    const res = await page.goto("https://forum.cfx.re/session/current.json", { waitUntil: "load" });
    const user = await res!.json().then((j: any) => j?.current_user?.username).catch(() => null);
    if (!user) throw new Error("stored session cookie is no longer valid");
    console.log(`[auth] forum session restored for: ${user}`);

    await finishPortalSso(page);

    console.log("Session cookie login successful!\n");
    return true;
  } catch (err) {
    console.warn(`Session cookie login failed: ${err}`);
    return false;
  }
}

/** The current forum "_t" cookie, for persisting the session across runs. */
export async function getForumSessionCookie(browser: Browser): Promise<string> {
  const cookies = await browser.defaultBrowserContext().cookies();
  return cookies.find((c) => c.name === "_t" && c.domain.includes("forum.cfx.re"))?.value ?? "";
}

async function loginWithEmailLink(browser: Browser, url: string, totpSecret?: string): Promise<boolean> {
  console.log("Attempting email link login...");

  const page = (await browser.pages())[0];

  try {
    // GET renders a confirmation form; the token is only consumed on submit
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 });
    await page.waitForSelector(".email-login-form .btn-primary", { timeout: 15_000 });

    // Accounts with TOTP 2FA get a code input on this page instead of a plain confirm
    const totpInput = await page.$(".second-factor-token-input");
    if (totpInput) {
      if (!totpSecret) {
        throw new Error(
          "account requires a TOTP code — add the authenticator's base32 secret " +
          "as repository secret CFX_TOTP_SECRET (input cfx_totp_secret)"
        );
      }
      console.log("[auth] filling TOTP code...");
      await totpInput.type(generateTotp(totpSecret), { delay: 50 });
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }).catch(() => {}),
      page.click(".email-login-form .btn-primary"),
    ]);
    console.log(`[auth] after email link submit: ${page.url()}`);

    // Verify the forum session actually exists before starting portal SSO
    const res = await page.goto("https://forum.cfx.re/session/current.json", { waitUntil: "load" });
    const user = await res!.json().then((j: any) => j?.current_user?.username).catch(() => null);
    if (!user) throw new Error("no forum session after email link submit (link expired or code rejected?)");
    console.log(`[auth] forum session established for: ${user}`);

    await finishPortalSso(page);

    console.log("Email link login successful!\n");
    return true;
  } catch (err) {
    const text = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => "N/A");
    console.error(`Email link login failed (URL: ${page.url()}): ${err}`);
    console.error(`Page text: ${text}`);
    return false;
  }
}

async function loginWithPasskey(browser: Browser): Promise<boolean> {
  const credential = await loadCredential();
  if (!credential) {
    console.log("[auth] no passkey credential configured — skipping passkey login");
    return false;
  }

  console.log("Attempting passkey login...");

  const page = (await browser.pages())[0];

  try {
    await setupVirtualAuthenticator(page, credential);

    // Step 1: portal → redirect to /login → click "SIGN IN WITH Cfx.re"
    //         → redirect via sso_provider to forum.cfx.re/login
    await page.goto(PORTAL_URL, { waitUntil: "load" });
    console.log(`[auth] after goto portal: ${page.url()}`);
    await clickLoginButton(page);
    console.log(`[auth] after 1st login click: ${page.url()}`);

    // Step 2: wait for passkey button on forum.cfx.re/login and click it
    //         → WebAuthn challenge → virtual auth handles it
    //         → POST /session/passkey/auth.json → redirect to forum.cfx.re/ (root)
    await page.waitForFunction(
      () => [...document.querySelectorAll("button")].some(b => b.textContent?.toLowerCase().includes("passkey")),
      { timeout: 15_000 }
    );
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load", timeout: 20_000 }).catch(() => {}),
      page.evaluate(() => {
        for (const b of document.querySelectorAll("button")) {
          if (b.textContent?.toLowerCase().includes("passkey")) {
            (b as HTMLElement).click();
            break;
          }
        }
      }),
    ]);
    console.log(`[auth] after passkey auth: ${page.url()}`);

    // The forum may refuse the login from an unknown device/location and mail a
    // one-time login link instead — bail out with instructions in that case.
    if (await isNewLocationBlocked(page)) {
      throw new NewLocationBlockError();
    }

    // Step 3: forum session established → finish portal SSO
    await finishPortalSso(page);

    console.log("Passkey login successful!\n");
    return true;
  } catch (err) {
    if (err instanceof NewLocationBlockError) throw err;
    if (await isNewLocationBlocked(page)) throw new NewLocationBlockError();

    const url = page.url();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => "N/A");
    console.error(`Passkey login failed (URL: ${url}): ${err}`);
    console.error(`Page text: ${text.slice(0, 300)}`);
    return false;
  }
}

const launchOptions = {
  headless: true,
  protocolTimeout: 120_000,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--window-size=1280,800",
  ],
  defaultViewport: { width: 1280, height: 800 },
};

export interface AuthOptions {
  /** Persisted forum "_t" cookie from a previous run — skips login entirely. */
  sessionCookie?: string;
  /** One-time "Log in via link" URL from the forum's new-device email. */
  emailLoginUrl?: string;
  /** Base32 TOTP secret, required when the account has 2FA enabled. */
  totpSecret?: string;
  /** Mailbox of the account's email address — enables fully automatic recovery
   *  from the new-device/location block. */
  imap?: ImapCredentials;
}

export async function getAuthenticatedContext(opts: AuthOptions = {}): Promise<Browser> {
  const browser = await puppeteer.launch(launchOptions);

  try {
    if (opts.sessionCookie) {
      if (await loginWithSessionCookie(browser, opts.sessionCookie)) return browser;
      console.warn("[auth] session cookie login failed — falling back");
    }

    // The email link goes before passkey: it is single-use, and a blocked passkey
    // attempt would trigger a fresh mail that invalidates it.
    if (opts.emailLoginUrl) {
      if (await loginWithEmailLink(browser, opts.emailLoginUrl, opts.totpSecret)) return browser;
      console.warn("[auth] email link login failed — falling back to passkey login");
    }

    const attemptStart = new Date();
    try {
      if (await loginWithPasskey(browser)) {
        return browser;
      }
    } catch (err) {
      // The blocked attempt itself triggers the "Log in via link" mail — with
      // mailbox access we can pick it up and finish the login unattended.
      if (err instanceof NewLocationBlockError && opts.imap) {
        console.log("[auth] new-location block — polling mailbox for the login link...");
        const link = await waitForLoginLink(opts.imap, attemptStart);
        if (link) {
          console.log("[auth] login link received via mailbox");
          if (await loginWithEmailLink(browser, link, opts.totpSecret)) return browser;
        } else {
          console.warn("[auth] no login link arrived in the mailbox within the timeout");
        }
      }
      throw err;
    }
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }

  await browser.close().catch(() => {});
  throw new Error(
    "All login methods failed. Provide a persisted session ('bun run setup-session' → " +
    "secret CFX_SESSION_COOKIE) and/or a passkey credential ('bun run setup-passkey' → " +
    "secret CFX_PASSKEY_CREDENTIAL)."
  );
}
