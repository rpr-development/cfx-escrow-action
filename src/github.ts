import { execFileSync } from "child_process";

const repo = () => process.env.GITHUB_REPOSITORY ?? "";
const patOrToken = () => process.env.GITHUB_PAT || process.env.GITHUB_TOKEN || "";

export function setGitHubVariable(name: string, value: string): void {
  // GITHUB_TOKEN lacks permissions for variables — a PAT with actions:write is required
  try {
    execFileSync("gh", ["variable", "set", name, "--body", value, "--repo", repo()], {
      env: { ...process.env, GH_TOKEN: patOrToken() },
    });
    console.log(`[gh] Variable ${name}=${value} saved`);
  } catch (e) {
    console.warn(`[gh] Could not save variable ${name} (PAT with actions:write scope required): ${e}`);
  }
}

export function getGitHubVariable(name: string): string {
  try {
    return execFileSync("gh", ["variable", "get", name, "--repo", repo()], {
      env: { ...process.env, GH_TOKEN: patOrToken() },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function deleteGitHubVariable(name: string): void {
  try {
    execFileSync("gh", ["variable", "delete", name, "--repo", repo()], {
      env: { ...process.env, GH_TOKEN: patOrToken() },
      stdio: ["pipe", "pipe", "ignore"],
    });
    console.log(`[gh] Variable ${name} deleted (single-use link)`);
  } catch (e) {
    console.warn(`[gh] Could not delete variable ${name} — remove it manually to avoid a stale login link: ${e}`);
  }
}

export function setGitHubSecret(name: string, value: string): void {
  // Writing secrets requires a PAT with repo scope; the default GITHUB_TOKEN cannot
  const token = process.env.GITHUB_PAT;
  if (!token) {
    console.warn(`[gh] No GITHUB_PAT — cannot persist ${name}; the next run will log in from scratch`);
    return;
  }
  try {
    // Value via stdin so it never appears in the process argument list
    execFileSync("gh", ["secret", "set", name, "--repo", repo()], {
      env: { ...process.env, GH_TOKEN: token },
      input: value,
      stdio: ["pipe", "pipe", "ignore"],
    });
    console.log(`[gh] Secret ${name} saved (forum session persisted for next run)`);
  } catch (e) {
    console.warn(`[gh] Could not save secret ${name}: ${e}`);
  }
}
