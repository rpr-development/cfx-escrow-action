/**
 * Based on https://github.com/ilovehugetits/9am-build — credits to the original authors.
 * Modified: removed chalk dependency.
 */
import puppeteer, { type Browser } from "puppeteer";
import { access, readFile, writeFile } from "fs/promises";
import path from "path";
import { setupVirtualAuthenticator, loadCredential } from "./passkey.js";

const AUTH_STATE_FILE = path.resolve(import.meta.dirname, "../auth-state.json");
const PORTAL_URL = "https://portal.cfx.re/assets/created-assets";

async function authStateExists(): Promise<boolean> {
  try {
    await access(AUTH_STATE_FILE);
    return true;
  } catch {
    return false;
  }
}

async function saveCookies(browser: Browser): Promise<void> {
  const cookies = await browser.defaultBrowserContext().cookies();
  await writeFile(AUTH_STATE_FILE, JSON.stringify(cookies, null, 2), "utf-8");
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

async function loginWithPasskey(browser: Browser): Promise<boolean> {
  const credential = await loadCredential();
  if (!credential) return false;

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
    // Expected: forum.cfx.re/ (root) — forum is now logged in, portal is not yet

    // Step 3: go back to portal → wait for login button (Next.js does client-side redirect
    //         to /login, URL after goto still shows assets/created-assets) → click sign in again
    //         → forum is logged in → sso_provider redirects to portal.cfx.re/authenticate?sso=...
    //         → portal processes SSO → portal logged in
    await page.goto(PORTAL_URL, { waitUntil: "load" });
    console.log(`[auth] after goto portal (2nd time): ${page.url()}`);

    const loginBtn = await page.waitForSelector('button[class*="login_noWrap"]', { timeout: 15_000 }).catch(() => null);
    if (loginBtn) {
      console.log("[auth] login button found, 2nd sign in click...");
      await clickLoginButton(page);
      console.log(`[auth] after 2nd login click: ${page.url()}`);
    } else {
      console.log("[auth] no login button — possibly already logged in on portal");
    }

    await waitForPortalLoaded(page, 30_000);

    console.log("Passkey login successful!\n");
    await saveCookies(browser);
    return true;
  } catch (err) {
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

export async function getAuthenticatedContext(): Promise<Browser> {
  const hasState = await authStateExists();

  if (hasState) {
    const browser = await puppeteer.launch(launchOptions);
    const page = (await browser.pages())[0];

    const raw = await readFile(AUTH_STATE_FILE, "utf-8");
    const cookies = JSON.parse(raw);
    await browser.defaultBrowserContext().setCookie(...cookies);

    await page.goto(PORTAL_URL, { waitUntil: "load" });

    try {
      await waitForPortalLoaded(page, 10_000);
      console.log("Existing session is valid.\n");
      return browser;
    } catch {
      console.log("Session expired, re-login required.\n");
      await browser.close();
    }
  }

  const browser = await puppeteer.launch(launchOptions);

  if (await loginWithPasskey(browser)) {
    return browser;
  }

  throw new Error("Passkey login failed. Please run 'bun run setup-passkey' to register a passkey.");
}
