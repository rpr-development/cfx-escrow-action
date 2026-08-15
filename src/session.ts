import type { Browser } from "puppeteer";
import { getAuthenticatedContext, getForumSessionCookie } from "./auth.js";
import { getGitHubVariable, deleteGitHubVariable, setGitHubSecret } from "./github.js";
import type { ImapCredentials } from "./mail.js";

// Secret CFX_IMAP_CREDENTIALS: {"host", "user", "password", "port": 993, "waitMinutes": 3}
function parseImapCredentials(): ImapCredentials | undefined {
  const raw = process.env.CFX_IMAP_CREDENTIALS;
  if (!raw) return undefined;
  try {
    const creds = JSON.parse(raw);
    if (creds.host && creds.user && creds.password) return creds;
    console.warn("[auth] CFX_IMAP_CREDENTIALS is missing host/user/password — ignoring");
  } catch {
    console.warn("[auth] CFX_IMAP_CREDENTIALS is not valid JSON — ignoring");
  }
  return undefined;
}

/**
 * Authenticate with the credential set from the environment (persisted session
 * cookie, one-time email link, TOTP secret, IMAP mailbox, passkey file) and
 * persist the resulting forum session for the next run.
 */
export async function authenticateFromEnv(): Promise<Browser> {
  // Manual escape hatch for the forum's new-device/location block: the one-time
  // "Log in via link" URL from the mail, via action input or repository variable.
  const envUrl = process.env.CFX_EMAIL_LOGIN_URL ?? "";
  const varUrl = envUrl ? "" : getGitHubVariable("CFX_EMAIL_LOGIN_URL");
  const emailLoginUrl = envUrl || varUrl;
  if (emailLoginUrl) console.log(`[auth] email login link provided via ${envUrl ? "input" : "repository variable"}`);

  const sessionCookie = process.env.CFX_SESSION_COOKIE || "";

  const browser = await getAuthenticatedContext({
    sessionCookie: sessionCookie || undefined,
    emailLoginUrl: emailLoginUrl || undefined,
    totpSecret: process.env.CFX_TOTP_SECRET || undefined,
    imap: parseImapCredentials(),
  });

  // The link is single-use — drop the variable so later runs don't retry a stale token
  if (varUrl) deleteGitHubVariable("CFX_EMAIL_LOGIN_URL");

  // Persist the forum session so the next run can skip logging in (and with it
  // the forum's new-device/location check, which fires on logins only)
  const forumSession = await getForumSessionCookie(browser);
  if (forumSession && forumSession !== sessionCookie) {
    setGitHubSecret("CFX_SESSION_COOKIE", forumSession);
  }

  return browser;
}
