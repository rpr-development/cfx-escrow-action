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
const KNOWN_ASSET_ID = process.env.CFX_ASSET_ID ? parseInt(process.env.CFX_ASSET_ID) : NaN;

const OUTPUT_DIR  = path.join(RESOURCE_DIR, ".build");
const API_BASE    = "https://portal-api.cfx.re/v1";
const CHUNK_SIZE  = 7 * 1024 * 1024; // 7 MB per chunk

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

function uploadBody(totalSize: number) {
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
  return {
    name: REPO_NAME,
    chunk_count: chunkCount,
    chunk_size: CHUNK_SIZE,
    total_size: totalSize,
    original_file_name: `${REPO_NAME}.zip`,
  };
}

// ─── Create or re-upload + wait for active ────────────────────────────────────

async function ensureAssetAndUpload(cookie: string, zipPath: string): Promise<number> {
  const stat = await (await openFile(zipPath, "r")).stat();
  const totalSize = stat.size;
  const chunkCount = Math.ceil(totalSize / CHUNK_SIZE);
  const body = uploadBody(totalSize);

  let assetId: number;
  let versionId: number;

  if (!isNaN(KNOWN_ASSET_ID)) {
    console.log(`[portal] Re-uploading to asset ${KNOWN_ASSET_ID}...`);
    const r = await apiPost(cookie, `/assets/${KNOWN_ASSET_ID}/re-upload`, body);
    assetId = r.asset_id;
    versionId = r.version_id;
  } else {
    const existingId = await findAssetId(cookie, REPO_NAME);
    if (existingId) {
      console.log(`[portal] Asset '${REPO_NAME}' found → ID ${existingId}`);
      await setGitHubVariable("CFX_ASSET_ID", String(existingId));
      const r = await apiPost(cookie, `/assets/${existingId}/re-upload`, body);
      assetId = r.asset_id;
      versionId = r.version_id;
    } else {
      console.log(`[portal] Asset '${REPO_NAME}' not found — creating...`);
      const r = await apiPost(cookie, "/me/assets", body);
      assetId = r.asset_id;
      versionId = r.version_id;
      await setGitHubVariable("CFX_ASSET_ID", String(assetId));
      console.log(`[portal] Asset created → ID ${assetId}`);
    }
  }

  await uploadChunks(cookie, assetId, versionId, zipPath, totalSize, chunkCount);
  return assetId;
}

// ─── Wait for portal processing + download ───────────────────────────────────

async function waitAndDownload(cookie: string, assetId: number): Promise<string> {
  console.log("[portal] Waiting for escrow processing...");

  for (let attempt = 0; attempt < 36; attempt++) {
    for (let page = 1; page <= 20; page++) {
      const data = await apiGet(cookie, `/me/assets?page=${page}&search=&sort=asset.id&direction=desc`);
      const asset = (data.items ?? []).find((a: any) => a.id === assetId);

      if (asset) {
        if (asset.state === "active") {
          const version = asset.versions?.[0];
          const pack = version?.packs?.[0];
          if (version && pack) {
            return downloadEscrowed(cookie, assetId, version.id, pack.id);
          }
        }
        break; // Asset found but not active yet, stop paginating
      }
      if (page >= (data.page_count ?? 1)) break;
    }

    console.log(`[portal] Not active yet, waiting 5s... (${attempt + 1}/36)`);
    await sleep(5000);
  }

  throw new Error("Timeout: asset did not become 'active' within 3 minutes.");
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

// ─── Delete asset ─────────────────────────────────────────────────────────────

async function deleteAsset(cookie: string, assetId: number): Promise<void> {
  const resp = await fetch(`${API_BASE}/assets/${assetId}`, {
    method: "DELETE",
    headers: API_HEADERS(cookie),
  });
  if (!resp.ok) throw new Error(`DELETE /assets/${assetId} → ${resp.status} ${await resp.text()}`);
  console.log(`[portal] Asset ${assetId} deleted.`);
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
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const tag = `v${date}-${GITHUB_SHA}`;
  const title = `${REPO_NAME} ${date} (${GITHUB_SHA})`;

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

  const assetId = await ensureAssetAndUpload(cookie, zipPath);

  console.log("[download] Waiting for processing + fetching escrowed zip...");
  const escrowed = await waitAndDownload(cookie, assetId);

  console.log("[release] Creating GitHub Release...");
  await createGitHubRelease(escrowed);

  await rm(OUTPUT_DIR, { recursive: true, force: true });
  console.log("\n=== Done! ===\n");
}

main().catch((e) => {
  console.error("\nDeploy failed:", e);
  process.exit(1);
});
