/**
 * setup-session.ts  —  run: bun run setup-session [owner/repo ...]
 *
 * Bootstrap the persisted forum session for the deploy action:
 *   1. Opens a visible browser on the Cfx.re Forum login page
 *   2. Log in manually (passkey, email link + 2FA — whatever the forum asks)
 *   3. The script reads the long-lived "_t" session cookie and stores it as
 *      GitHub secret CFX_SESSION_COOKIE on every repo passed as argument
 *      (or prints follow-up instructions when no repos are given)
 *
 * The action restores this session on every run and saves the rotated cookie
 * back (requires github_pat), so this is normally needed only once.
 */
import puppeteer from "puppeteer";
import { execFileSync } from "child_process";
import { createInterface } from "readline";

const FORUM_LOGIN_URL = "https://forum.cfx.re/login";

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
  const repos = process.argv.slice(2);

  console.log("\n=== Cfx.re Session Setup ===\n");

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    args: ["--window-size=1280,800"],
  });

  const page = (await browser.pages())[0];

  console.log("Browser opened. Log in to the Cfx.re Forum...");
  await page.goto(FORUM_LOGIN_URL, { waitUntil: "load" });

  await waitForEnter("\nPress Enter once you are logged in...");

  const cookies = await browser.defaultBrowserContext().cookies();
  const t = cookies.find((c) => c.name === "_t" && c.domain.includes("forum.cfx.re"));

  await browser.close();

  if (!t) {
    console.error("\nNo '_t' session cookie found. Are you logged in?");
    process.exit(1);
  }

  console.log(`\nSession cookie captured (valid until ${new Date(t.expires * 1000).toISOString().slice(0, 10)}).`);

  if (repos.length === 0) {
    console.log("\nNo repos given — store it yourself on every repo that deploys:");
    console.log("  bun run setup-session your-org/your-repo [more/repos ...]");
    console.log("or manually:");
    console.log(`  gh secret set CFX_SESSION_COOKIE --repo your-org/your-repo --body "${t.value}"`);
    return;
  }

  for (const repo of repos) {
    try {
      // Value via stdin so it never appears in the process argument list
      execFileSync("gh", ["secret", "set", "CFX_SESSION_COOKIE", "--repo", repo], {
        input: t.value,
        stdio: ["pipe", "inherit", "inherit"],
      });
      console.log(`Secret CFX_SESSION_COOKIE set on ${repo}`);
    } catch (e) {
      console.error(`Failed to set secret on ${repo}: ${e}`);
    }
  }

  console.log("\n=== Done! ===\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
