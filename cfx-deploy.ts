/**
 * cfx-deploy.ts
 *
 * Run by the composite action from the repo root.
 * RESOURCE_DIR env var points to the FiveM resource directory (e.g. dist/).
 *
 * Uses the portal-api.cfx.re REST API directly — no Puppeteer UI automation
 * for upload/download. Puppeteer is only used for authentication.
 *
 * Flow:
 *   1. Build zip of the resource
 *   2. Auth via Puppeteer (retrieve session cookies)
 *   3. Find asset by name, create if it doesn't exist
 *   4. Upload via chunked API
 *   5. Wait until portal has processed (state: active)
 *   6. Download escrowed zip via pre-signed URL
 *   7. Create GitHub Release
 */
import path from "path";
import { existsSync } from "fs";
import { mkdir, rm, mkdtemp, readFile, open as openFile, writeFile, cp } from "fs/promises";
import os from "os";
import archiver from "archiver";
import { createWriteStream } from "fs";
import { glob } from "glob";
import { execFileSync } from "child_process";

import { getAuthenticatedContext } from "./src/auth.ts";

// ─── Environment ──────────────────────────────────────────────────────────────

const RESOURCE_DIR = process.env.RESOURCE_DIR!;
const REPO_NAME    = process.env.REPO_NAME ?? path.basename(RESOURCE_DIR);
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY!;
const GITHUB_SHA   = (process.env.GITHUB_SHA ?? "unknown").slice(0, 7);
const KNOWN_ASSET_ID       = process.env.CFX_ASSET_ID ? parseInt(process.env.CFX_ASSET_ID) : NaN;
// Strip leading 'v' so tags like 'v1.2.3' become '1.2.3'
const CFX_VERSION_OVERRIDE = (process.env.CFX_VERSION || "").replace(/^v(?=\d)/i, "");
const CFX_RELEASE_CANDIDATE = process.env.CFX_RELEASE_CANDIDATE === "true";

function buildChangelog(): string {
  // Explicit input (e.g. GitHub Release body) takes priority
  const explicit = process.env.CFX_CHANGELOG ?? "";
  if (explicit && explicit !== "Automated release") return explicit;

  // Auto-generate from git commits since the last tag (or last 10 commits as fallback)
  try {
    const lastTag = execFileSync("git", ["describe", "--tags", "--abbrev=0", "HEAD^"], {
      cwd: RESOURCE_DIR,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    return execFileSync(
      "git", ["log", `${lastTag}..HEAD`, "--pretty=format:- %s", "--no-merges"],
      { cwd: RESOURCE_DIR, encoding: "utf-8" }
    ).trim() || `Automated release (${GITHUB_SHA})`;
  } catch {
    // No previous tag — take the last 10 commits
    try {
      return execFileSync(
        "git", ["log", "-10", "--pretty=format:- %s", "--no-merges"],
        { cwd: RESOURCE_DIR, encoding: "utf-8" }
      ).trim() || `Automated release (${GITHUB_SHA})`;
    } catch {
      return `Automated release (${GITHUB_SHA})`;
    }
  }
}

const CFX_CHANGELOG = buildChangelog();

function readFxManifestVersion(): string {
  const manifestPath = path.join(RESOURCE_DIR, "fxmanifest.lua");
  if (!existsSync(manifestPath)) return "";
  try {
    const content = require("fs").readFileSync(manifestPath, "utf-8");
    const m = content.match(/^\s*version\s+['"]([^'"]+)['"]/m);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

const OUTPUT_DIR  = path.join(RESOURCE_DIR, ".build");
const API_BASE    = "https://portal-api.cfx.re/v1";
const CHUNK_SIZE  = 7 * 1024 * 1024; // 7 MB per chunk

// Resolved once at startup — priority: input override → fxmanifest.lua → short SHA
const RESOLVED_VERSION = CFX_VERSION_OVERRIDE || readFxManifestVersion() || GITHUB_SHA;

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config { exclude: string[] }

async function loadConfig(): Promise<Config> {
  const p = path.join(RESOURCE_DIR, "upload-config.json");
  if (existsSync(p)) {
    const raw = JSON.parse(await readFile(p, "utf-8"));
    return { exclude: raw.exclude ?? [] };
  }
  return { exclude: [".gitignore", ".github/**", ".claude/**"] };
}

// ─── Build ────────────────────────────────────────────────────────────────────

const ALWAYS_EXCLUDE = ["**/node_modules/**", "**/.build/**", "**/.git/**", "**/.9am-build/**"];

async function buildZip(config: Config): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), `${REPO_NAME}-`));

  try {
    const files = await glob("**/*", {
      cwd: RESOURCE_DIR,
      nodir: true,
      dot: false,
      ignore: [...ALWAYS_EXCLUDE, ...config.exclude],
    });

    for (const file of files) {
      const dest = path.join(tempDir, file);
      await mkdir(path.dirname(dest), { recursive: true });
      await cp(path.join(RESOURCE_DIR, file), dest);
    }

    const zipPath = path.join(OUTPUT_DIR, `${REPO_NAME}.zip`);
    await createZip(tempDir, zipPath);
    return zipPath;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function createZip(sourceDir: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(outputPath);
    const arc = archiver("zip", { zlib: { level: 9 } });
    out.on("close", resolve);
    arc.on("error", reject);
    arc.pipe(out);
    arc.directory(sourceDir, false);
    arc.finalize();
  });
}

// ─── Auth: cookies from Puppeteer browser ────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function getPortalCookies(): Promise<string> {
  const browser = await getAuthenticatedContext();

  try {
    // Ensure portal is loaded so portal-api cookies are set
    const page = (await browser.pages())[0];
    await page.goto("https://portal.cfx.re/assets/created-assets", {
      waitUntil: "load",
      timeout: 30_000,
    });
    await sleep(2000);

    // Retrieve all cookies for portal-api.cfx.re
    const cookies = await page.cookies("https://portal-api.cfx.re");

    if (cookies.length === 0) {
      // Fallback: all cookies (portal.cfx.re shares session with portal-api.cfx.re)
      const allCookies = await browser.defaultBrowserContext().cookies();
      return allCookies
        .filter((c) => c.domain.includes("cfx.re"))
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
    }

    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } finally {
    await browser.close();
  }
}

// ─── Portal REST API ──────────────────────────────────────────────────────────

const API_HEADERS = (cookie: string) => ({
  Cookie: cookie,
  Origin: "https://portal.cfx.re",
  Referer: "https://portal.cfx.re/",
  "User-Agent": "Mozilla/5.0 cfx-deploy-workflow",
});

async function apiGet(cookie: string, path: string): Promise<any> {
  const resp = await fetch(`${API_BASE}${path}`, { headers: API_HEADERS(cookie) });
  if (!resp.ok) throw new Error(`GET ${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function apiPost(cookie: string, path: string, body?: object): Promise<any> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { ...API_HEADERS(cookie), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) throw new Error(`POST ${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ─── Find asset ───────────────────────────────────────────────────────────────

async function findAssetId(cookie: string, name: string): Promise<number | null> {
  for (let page = 1; page <= 20; page++) {
    const data = await apiGet(cookie, `/me/assets?page=${page}&search=${encodeURIComponent(name)}&sort=asset.id&direction=desc`);
    const asset = (data.items ?? []).find((a: any) => a.name === name);
    if (asset) return asset.id;
    if (page >= (data.page_count ?? 1)) break;
  }
  return null;
}

// ─── Chunked upload ───────────────────────────────────────────────────────────

async function uploadChunks(
  cookie: string,
  assetId: number,
  versionId: number,
  zipPath: string,
  totalSize: number,
  chunkCount: number
): Promise<void> {
  const fd = await openFile(zipPath, "r");
  try {
    for (let i = 0; i < chunkCount; i++) {
      const offset = i * CHUNK_SIZE;
      const size = Math.min(CHUNK_SIZE, totalSize - offset);
      const buffer = Buffer.alloc(size);
      await fd.read(buffer, 0, size, offset);

      const form = new FormData();
      form.append("chunk_id", String(i));
      form.append("chunk", new Blob([buffer]), `chunk_${i}`);

      const resp = await fetch(
        `${API_BASE}/assets/${assetId}/versions/${versionId}/upload-chunk`,
        { method: "POST", headers: API_HEADERS(cookie), body: form }
      );
      if (!resp.ok) throw new Error(`Chunk ${i} upload → ${resp.status}`);
      console.log(`[upload] Chunk ${i + 1}/${chunkCount}`);
    }
  } finally {
    await fd.close();
  }

  await apiPost(cookie, `/assets/${assetId}/versions/${versionId}/complete-upload`);
  console.log("[upload] Upload complete.");
}

function baseUploadBody(totalSize: number) {
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
  return {
    name: REPO_NAME,
    chunk_count: chunkCount,
    chunk_size: CHUNK_SIZE,
    total_size: totalSize,
    original_file_name: `${REPO_NAME}.zip`,
    release_candidate: CFX_RELEASE_CANDIDATE,
    version: RESOLVED_VERSION,
  };
}

function reUploadBody(totalSize: number) {
  return { ...baseUploadBody(totalSize), changelog: CFX_CHANGELOG };
}

// ─── Create or re-upload + wait for active ────────────────────────────────────

async function ensureAssetAndUpload(cookie: string, zipPath: string): Promise<{ assetId: number; versionId: number }> {
  const stat = await (await openFile(zipPath, "r")).stat();
  const totalSize = stat.size;
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);

  let assetId: number;
  let versionId: number;

  if (!isNaN(KNOWN_ASSET_ID)) {
    console.log(`[portal] Re-uploading to asset ${KNOWN_ASSET_ID}...`);
    const r = await reUpload(cookie, KNOWN_ASSET_ID, reUploadBody(totalSize));
    assetId = r.asset_id;
    versionId = r.version_id;
  } else {
    const existingId = await findAssetId(cookie, REPO_NAME);
    if (existingId) {
      console.log(`[portal] Asset '${REPO_NAME}' found → ID ${existingId}`);
      await setGitHubVariable("CFX_ASSET_ID", String(existingId));
      const r = await reUpload(cookie, existingId, reUploadBody(totalSize));
      assetId = r.asset_id;
      versionId = r.version_id;
    } else {
      console.log(`[portal] Asset '${REPO_NAME}' not found — creating...`);
      const r = await apiPost(cookie, "/me/assets", baseUploadBody(totalSize));
      assetId = r.asset_id;
      versionId = r.version_id;
      await setGitHubVariable("CFX_ASSET_ID", String(assetId));
      console.log(`[portal] Asset created → ID ${assetId}`);
    }
  }

  await uploadChunks(cookie, assetId, versionId, zipPath, totalSize, chunkCount);
  return { assetId, versionId };
}

// ─── Wait for portal processing + download ───────────────────────────────────

async function waitAndDownload(cookie: string, assetId: number, targetVersionId: number): Promise<string> {
  console.log("[portal] Waiting for escrow processing...");

  let lastState = "";
  let attempt = 0;

  // Poll indefinitely — rely on GitHub Actions concurrency cancellation (SIGTERM)
  // to stop a stale run when a newer push arrives. A 3-hour hard cap exists
  // only as a safety net (CFX documentation states processing can take up to 2 hours).
  while (attempt < 1080) {
    const asset = await apiGet(cookie, `/assets/${assetId}`);
    const version = (asset.versions ?? []).find((v: any) => v.id === targetVersionId);
    const state: string = version?.state ?? asset.state ?? "unknown";

    if (state !== lastState) {
      console.log(`[portal] Version state: ${state}`);
      lastState = state;
    }

    if (state === "active") {
      const pack = version?.packs?.[0];
      if (version && pack) {
        return downloadEscrowed(cookie, assetId, version.id, pack.id);
      }
    }

    if (state === "error" || state === "invalid") {
      const errors = version?.errors;
      const detail = errors ? "\n" + JSON.stringify(errors, null, 2) : "";
      throw new Error(`Escrow processing failed (state: ${state}) for version ${targetVersionId}:${detail}`);
    }

    attempt++;
    console.log(`[portal] Waiting 10s... (${attempt}/1080)`);
    await sleep(10_000);
  }

  throw new Error("Safety-net timeout: asset did not become 'active' within 3 hours.");
}

async function downloadEscrowed(
  cookie: string,
  assetId: number,
  versionId: number,
  packId: number
): Promise<string> {
  const data = await apiGet(
    cookie,
    `/assets/${assetId}/versions/${versionId}/packs/${packId}/download`
  );
  const url: string = data.url;
  console.log("[portal] Download URL obtained.");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  const destPath = path.join(OUTPUT_DIR, `${REPO_NAME}-escrowed.zip`);
  await writeFile(destPath, buffer);
  console.log(`[portal] Escrowed zip saved: ${destPath}`);
  return destPath;
}

// ─── Delete asset / version ───────────────────────────────────────────────────

async function deleteAsset(cookie: string, assetId: number): Promise<void> {
  const resp = await fetch(`${API_BASE}/assets/${assetId}`, {
    method: "DELETE",
    headers: API_HEADERS(cookie),
  });
  if (!resp.ok) throw new Error(`DELETE /assets/${assetId} → ${resp.status} ${await resp.text()}`);
  console.log(`[portal] Asset ${assetId} deleted.`);
}

async function deleteVersion(cookie: string, assetId: number, versionId: number): Promise<void> {
  const resp = await fetch(`${API_BASE}/assets/${assetId}/versions/${versionId}`, {
    method: "DELETE",
    headers: API_HEADERS(cookie),
  });
  if (!resp.ok) throw new Error(`DELETE /assets/${assetId}/versions/${versionId} → ${resp.status} ${await resp.text()}`);
  console.log(`[portal] Version ${versionId} deleted.`);
}

async function reUpload(cookie: string, assetId: number, body: object): Promise<any> {
  const resp = await fetch(`${API_BASE}/assets/${assetId}/re-upload`, {
    method: "POST",
    headers: { ...API_HEADERS(cookie), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (resp.status === 409) {
    const text = await resp.text();
    let errorCode: string | undefined;
    try { errorCode = JSON.parse(text).error_code; } catch {}

    const asset = await apiGet(cookie, `/assets/${assetId}`);
    const versions: any[] = asset.versions ?? [];

    if (errorCode === "DUPLICATE_VERSION") {
      const versionNumber = (body as any).version;
      const duplicate = versions.find((v: any) => v.version === versionNumber);
      if (!duplicate) throw new Error(`409 DUPLICATE_VERSION for '${versionNumber}' but version not found in list`);
      console.log(`[portal] Duplicate version '${versionNumber}' (id ${duplicate.id}) — deleting and retrying...`);
      await deleteVersion(cookie, assetId, duplicate.id);
    } else {
      const sorted = versions.slice().sort((a: any, b: any) => a.id - b.id);
      if (sorted.length === 0) throw new Error(`409 max versions but no versions found to delete`);
      console.log(`[portal] Max versions reached — deleting oldest version ${sorted[0].id} and retrying...`);
      await deleteVersion(cookie, assetId, sorted[0].id);
    }

    return apiPost(cookie, `/assets/${assetId}/re-upload`, body);
  }

  if (!resp.ok) throw new Error(`POST /assets/${assetId}/re-upload → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// ─── GitHub variable + Release ────────────────────────────────────────────────

async function setGitHubVariable(name: string, value: string): Promise<void> {
  // GITHUB_TOKEN lacks permissions for variables — a PAT with actions:write is required
  const token = process.env.GITHUB_PAT || GITHUB_TOKEN;
  try {
    execFileSync("gh", ["variable", "set", name, "--body", value, "--repo", GITHUB_REPOSITORY], {
      env: { ...process.env, GH_TOKEN: token },
    });
    console.log(`[gh] Variable ${name}=${value} saved`);
  } catch (e) {
    console.warn(`[gh] Could not save variable ${name} (PAT with actions:write scope required): ${e}`);
  }
}

async function createGitHubRelease(zipPath: string): Promise<void> {
  const existingTag = process.env.GITHUB_REF_NAME ?? "";
  const isReleaseTrigger = process.env.GITHUB_EVENT_NAME === "release";

  if (isReleaseTrigger && existingTag) {
    // A GitHub Release already exists — just upload the escrowed zip to it
    execFileSync(
      "gh",
      ["release", "upload", existingTag, zipPath, "--clobber", "--repo", GITHUB_REPOSITORY],
      { env: { ...process.env, GH_TOKEN: GITHUB_TOKEN }, stdio: "inherit" }
    );
    console.log(`[gh] Escrowed zip attached to existing release ${existingTag}`);
  } else {
    // Push / workflow_dispatch — create a new release
    const tag = `v${RESOLVED_VERSION}`;
    const title = `${REPO_NAME} v${RESOLVED_VERSION}`;

    execFileSync(
      "gh",
      [
        "release", "create", tag, zipPath,
        "--title", title,
        "--notes", `Automated release from commit \`${GITHUB_SHA}\`.\n\nDownload the zip and place its contents in your FiveM resources folder.`,
        "--repo", GITHUB_REPOSITORY,
      ],
      { env: { ...process.env, GH_TOKEN: GITHUB_TOKEN }, stdio: "inherit" }
    );
    console.log(`[gh] Release created: ${tag}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RESOURCE_DIR)      throw new Error("RESOURCE_DIR env var missing");
  if (!GITHUB_TOKEN)      throw new Error("GITHUB_TOKEN env var missing");
  if (!GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY env var missing");

  console.log(`\n=== cfx-deploy: ${REPO_NAME} ===\n`);

  const config = await loadConfig();

  console.log("[build] Building zip...");
  const zipPath = await buildZip(config);
  console.log(`[build] Done: ${zipPath}`);

  console.log("[auth] Fetching session cookies via Puppeteer...");
  const cookie = await getPortalCookies();
  console.log(`[auth] ${cookie.split(";").length} cookies obtained`);

  const { assetId, versionId } = await ensureAssetAndUpload(cookie, zipPath);

  console.log("[download] Waiting for processing + fetching escrowed zip...");
  const escrowed = await waitAndDownload(cookie, assetId, versionId);

  console.log("[release] Creating GitHub Release...");
  await createGitHubRelease(escrowed);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  console.log("\n=== Done! ===\n");
}

main().catch((e) => {
  console.error("\nDeploy failed:", e);
  process.exit(1);
});
