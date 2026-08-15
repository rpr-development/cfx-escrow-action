import { ImapFlow } from "imapflow";

export interface ImapCredentials {
  host: string;
  port?: number;
  user: string;
  password: string;
  /** How long to wait for the login mail to arrive (default 3). Raise this when
   *  a human forwards the mail to this mailbox manually (e.g. 15). */
  waitMinutes?: number;
}

const LOGIN_LINK_RE = /https:\/\/forum\.cfx\.re\/session\/email-login\/[a-f0-9]+/;
const LOGIN_MAIL_SUBJECT = "Log in via link";

/**
 * Poll the mailbox until the forum's "Log in via link" mail triggered by the
 * blocked login attempt arrives. Only mails newer than `since` count — every
 * blocked attempt sends a fresh link that invalidates older ones.
 *
 * The mailbox does not have to be the account's own: a (manually or rule-based)
 * forwarded copy works too — IMAP SUBJECT search is a substring match, so
 * "Fwd: Log in via link" is found as well.
 */
export async function waitForLoginLink(creds: ImapCredentials, since: Date): Promise<string | null> {
  const waitMinutes = creds.waitMinutes ?? 3;
  console.log(`[mail] polling ${creds.host} for the login mail (up to ${waitMinutes} min)...`);
  const deadline = Date.now() + waitMinutes * 60_000;

  while (Date.now() < deadline) {
    const link = await fetchNewestLoginLink(creds, since).catch((e) => {
      console.warn(`[mail] IMAP check failed: ${e}`);
      return null;
    });
    if (link) return link;

    console.log("[mail] login link not in mailbox yet — retrying in 10s...");
    await new Promise((r) => setTimeout(r, 10_000));
  }

  return null;
}

async function fetchNewestLoginLink(creds: ImapCredentials, since: Date): Promise<string | null> {
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port ?? 993,
    secure: true,
    auth: { user: creds.user, pass: creds.password },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      // IMAP SINCE has day granularity — precise filtering on internalDate below
      const uids = await client.search({ since, subject: LOGIN_MAIL_SUBJECT }, { uid: true });
      if (!uids || uids.length === 0) return null;

      let newest: { uid: number; date: Date } | null = null;
      for await (const msg of client.fetch(uids, { internalDate: true }, { uid: true })) {
        if (msg.internalDate && (!newest || msg.internalDate > newest.date)) {
          newest = { uid: msg.uid, date: msg.internalDate };
        }
      }
      // 60s clock-skew margin between the runner and the mail server
      if (!newest || newest.date.getTime() < since.getTime() - 60_000) return null;

      const full = await client.fetchOne(String(newest.uid), { source: true }, { uid: true });
      if (!full || !full.source) return null;
      // Strip quoted-printable soft line breaks — forwarding can re-encode the
      // body and wrap the link mid-token
      const raw = full.source.toString("utf-8").replace(/=\r?\n/g, "");
      const match = raw.match(LOGIN_LINK_RE);
      return match ? match[0] : null;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}
