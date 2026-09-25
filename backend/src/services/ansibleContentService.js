import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { updateSettings } from "./settingsStore.js";
import {
  syncCustomBlueprintsFromCatalog,
  offboardCustomBlueprints,
} from "./appCatalogService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BUNDLED_PIN = "bundled";
export const CUSTOM_SOURCE = "custom";
export const BUNDLED_SOURCE = "bundled";

export function bundledContentRoot() {
  const candidates = [
    process.env.ANSIBLE_CONTENT_BUNDLED,
    path.resolve(__dirname, "../../../ansible/content"),
    "/app/ansible/content",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/** Pack used for “Download template” in Ansible settings. */
export function contentTemplateRoot() {
  const candidates = [
    process.env.ANSIBLE_CONTENT_TEMPLATE,
    path.resolve(__dirname, "../../../ansible/content-template"),
    "/app/ansible/content-template",
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

export function contentCacheRoot() {
  return process.env.ANSIBLE_CONTENT_CACHE
    || path.join(os.tmpdir(), "forge-ansible-content");
}

function pinFromEnv() {
  return String(process.env.ANSIBLE_CONTENT_PIN || BUNDLED_PIN).trim() || BUNDLED_PIN;
}

function mountPathFromEnv() {
  return String(process.env.ANSIBLE_CONTENT_MOUNT_PATH || "").trim();
}

/**
 * Custom overlay root (additive to bundled).
 * Prefer host/container mount path when set; else git-synced pin cache.
 */
export function customContentRoot() {
  const mount = mountPathFromEnv();
  if (mount && fs.existsSync(mount)) return mount;

  const pin = pinFromEnv();
  if (pin !== BUNDLED_PIN) {
    const cached = path.join(contentCacheRoot(), pin);
    if (fs.existsSync(cached)) return cached;
  }
  return null;
}

export function hasCustomContent() {
  return !!customContentRoot();
}

/**
 * @deprecated Prefer resolveContentPath / rolesPathEnv — kept for status display.
 * Returns custom root when present, else bundled.
 */
export function activeContentRoot() {
  return customContentRoot() || bundledContentRoot();
}

/** Resolve a relative path: custom overlay wins, then bundled. */
export function resolveContentPath(...parts) {
  const rel = path.join(...parts);
  const custom = customContentRoot();
  if (custom) {
    const inCustom = path.join(custom, rel);
    if (fs.existsSync(inCustom)) return inCustom;
  }
  return path.join(bundledContentRoot(), rel);
}

/** Colon-separated ANSIBLE_ROLES_PATH: custom roles first, then bundled. */
export function rolesPathEnv() {
  const parts = [];
  const custom = customContentRoot();
  if (custom) {
    const r = path.join(custom, "roles");
    if (fs.existsSync(r)) parts.push(r);
  }
  const bundled = path.join(bundledContentRoot(), "roles");
  if (fs.existsSync(bundled)) parts.push(bundled);
  return parts.join(path.delimiter);
}

export function isContentReady() {
  const bundled = bundledContentRoot();
  if (!bundled || !fs.existsSync(bundled)) return false;
  const mount = mountPathFromEnv();
  if (mount && !fs.existsSync(mount)) return false;
  const pin = pinFromEnv();
  if (pin !== BUNDLED_PIN && !mount) {
    const cached = path.join(contentCacheRoot(), pin);
    if (!fs.existsSync(cached)) return false;
  }
  return true;
}

export function assertContentReadyForApps() {
  if (!isContentReady()) {
    const mount = mountPathFromEnv();
    const pin = pinFromEnv();
    if (mount && !fs.existsSync(mount)) {
      throw new Error(`Custom content mount path not found: ${mount}`);
    }
    if (pin !== BUNDLED_PIN && !mount) {
      throw new Error(
        `Ansible content pin ${pin.slice(0, 12)}… is not cached. Open Admin → Ansible and Sync custom content.`,
      );
    }
    throw new Error("Ansible content is not available (bundled tree missing).");
  }
  return contentStatus();
}

export function contentStatus() {
  const pin = pinFromEnv();
  const bundled = bundledContentRoot();
  const custom = customContentRoot();
  const mount = mountPathFromEnv();
  const cachedPath = pin === BUNDLED_PIN ? null : path.join(contentCacheRoot(), pin);
  return {
    pin,
    root: activeContentRoot(),
    bundledRoot: bundled,
    customRoot: custom,
    mountPath: mount || "",
    mountOk: mount ? fs.existsSync(mount) : null,
    usingBundled: !custom,
    hasCustom: !!custom,
    cacheOk: pin === BUNDLED_PIN ? !!(bundled && fs.existsSync(bundled)) : !!(cachedPath && fs.existsSync(cachedPath)),
    readyForApps: isContentReady(),
    gitUrl: process.env.ANSIBLE_CONTENT_GIT_URL || "",
    branch: process.env.ANSIBLE_CONTENT_GIT_BRANCH || "main",
    lastSyncAt: process.env.ANSIBLE_CONTENT_LAST_SYNC_AT || null,
    lastSyncError: process.env.ANSIBLE_CONTENT_LAST_SYNC_ERROR || null,
    tokenSet: !!String(process.env.ANSIBLE_CONTENT_GIT_TOKEN || "").trim(),
    lastOnboard: (() => {
      try {
        return JSON.parse(process.env.ANSIBLE_CONTENT_LAST_ONBOARD || "null");
      } catch {
        return null;
      }
    })(),
  };
}

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => resolve({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function loadCatalogDoc(root) {
  const jsonPath = path.join(root, "catalog.json");
  const yamlPath = path.join(root, "catalog.yaml");
  const ymlPath = path.join(root, "catalog.yml");

  if (fs.existsSync(jsonPath)) {
    const raw = await fsPromises.readFile(jsonPath, "utf8");
    return JSON.parse(raw);
  }

  const yamlFile = fs.existsSync(yamlPath) ? yamlPath : (fs.existsSync(ymlPath) ? ymlPath : null);
  if (!yamlFile) {
    const err = new Error("No catalog.yaml / catalog.json in custom content root");
    err.code = "NO_CATALOG";
    throw err;
  }

  const py2 = await run("python3", [
    "-c",
    `import json,yaml; print(json.dumps(yaml.safe_load(open(${JSON.stringify(yamlFile)})) or {}))`,
  ]);
  if (py2.code !== 0) {
    throw new Error(`Failed to parse catalog.yaml: ${(py2.stderr || py2.stdout || "").slice(0, 400)}`);
  }
  return JSON.parse(py2.stdout || "{}");
}

async function applyCatalogFromCustomRoot(customRoot, { offboardIfMissing = false } = {}) {
  if (!customRoot) {
    const removed = await offboardCustomBlueprints();
    updateSettings({
      ANSIBLE_CONTENT_LAST_ONBOARD: JSON.stringify({
        at: new Date().toISOString(),
        onboarded: [],
        updated: [],
        removed: removed.map((r) => r.id),
        warnings: ["No custom content — offboarded custom blueprints"],
      }),
    });
    return { onboarded: [], updated: [], removed, warnings: ["No custom content"] };
  }

  let doc;
  try {
    doc = await loadCatalogDoc(customRoot);
  } catch (err) {
    if (err.code === "NO_CATALOG" && offboardIfMissing) {
      const removed = await offboardCustomBlueprints();
      return {
        onboarded: [],
        updated: [],
        removed,
        warnings: ["Custom root has no catalog.yaml — offboarded previous custom blueprints"],
      };
    }
    throw err;
  }

  const result = await syncCustomBlueprintsFromCatalog(doc, { contentRoot: customRoot });
  updateSettings({
    ANSIBLE_CONTENT_LAST_ONBOARD: JSON.stringify({
      at: new Date().toISOString(),
      ...result,
    }),
  });
  return result;
}

/**
 * Sync custom content (git) as an overlay; onboard catalog.yaml.
 * Empty git URL + empty mount → offboard custom blueprints; bundled unchanged.
 */
export async function syncAnsibleContent() {
  const url = String(process.env.ANSIBLE_CONTENT_GIT_URL || "").trim();
  const branch = String(process.env.ANSIBLE_CONTENT_GIT_BRANCH || "main").trim() || "main";
  const token = String(process.env.ANSIBLE_CONTENT_GIT_TOKEN || "").trim();
  const mount = mountPathFromEnv();

  // Mount-only: validate + onboard (no git clone).
  if (!url && mount) {
    if (!fs.existsSync(mount)) {
      const err = `Mount path not found: ${mount}`;
      updateSettings({
        ANSIBLE_CONTENT_LAST_SYNC_AT: new Date().toISOString(),
        ANSIBLE_CONTENT_LAST_SYNC_ERROR: err,
      });
      throw new Error(err);
    }
    updateSettings({
      ANSIBLE_CONTENT_PIN: BUNDLED_PIN,
      ANSIBLE_CONTENT_LAST_SYNC_AT: new Date().toISOString(),
      ANSIBLE_CONTENT_LAST_SYNC_ERROR: "",
    });
    const onboard = await applyCatalogFromCustomRoot(mount);
    return {
      ...contentStatus(),
      message: `Mounted custom content · onboarded ${onboard.onboarded.length}, updated ${onboard.updated.length}`,
      onboard,
    };
  }

  if (!url) {
    updateSettings({
      ANSIBLE_CONTENT_PIN: BUNDLED_PIN,
      ANSIBLE_CONTENT_LAST_SYNC_AT: new Date().toISOString(),
      ANSIBLE_CONTENT_LAST_SYNC_ERROR: "",
    });
    const onboard = await applyCatalogFromCustomRoot(null);
    return {
      ...contentStatus(),
      message: "No custom source — using bundled content only; custom blueprints offboarded",
      onboard,
    };
  }

  let cloneUrl = url;
  if (token && /^https:\/\//i.test(url)) {
    cloneUrl = url.replace(/^https:\/\//i, `https://x-access-token:${encodeURIComponent(token)}@`);
  }

  const staging = await fsPromises.mkdtemp(path.join(os.tmpdir(), "forge-content-sync-"));
  try {
    const clone = await run("git", ["clone", "--depth", "1", "--branch", branch, cloneUrl, "repo"], { cwd: staging });
    if (clone.code !== 0) {
      const err = (clone.stderr || clone.stdout || "git clone failed").slice(0, 500);
      updateSettings({
        ANSIBLE_CONTENT_LAST_SYNC_AT: new Date().toISOString(),
        ANSIBLE_CONTENT_LAST_SYNC_ERROR: err,
      });
      throw new Error(err);
    }
    const repoDir = path.join(staging, "repo");
    const rev = await run("git", ["rev-parse", "HEAD"], { cwd: repoDir });
    const sha = (rev.stdout || "").trim().slice(0, 40) || `sync-${Date.now()}`;
    const dest = path.join(contentCacheRoot(), sha);
    await fsPromises.mkdir(contentCacheRoot(), { recursive: true });
    if (fs.existsSync(dest)) {
      await fsPromises.rm(dest, { recursive: true, force: true });
    }
    await fsPromises.cp(repoDir, dest, { recursive: true });
    updateSettings({
      ANSIBLE_CONTENT_PIN: sha,
      ANSIBLE_CONTENT_LAST_SYNC_AT: new Date().toISOString(),
      ANSIBLE_CONTENT_LAST_SYNC_ERROR: "",
    });

    // Mount still wins for runtime overlay when both are set; still validate git catalog.
    const onboardRoot = (mount && fs.existsSync(mount)) ? mount : dest;
    const onboard = await applyCatalogFromCustomRoot(onboardRoot);
    return {
      ...contentStatus(),
      message: `Synced custom overlay ${sha.slice(0, 12)} · onboarded ${onboard.onboarded.length}, updated ${onboard.updated.length}`,
      onboard,
    };
  } finally {
    await fsPromises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

/** Build a tar.gz of the content-template pack for download. */
export async function buildContentTemplateArchive() {
  const root = contentTemplateRoot();
  if (!root || !fs.existsSync(root)) {
    throw new Error("Content template pack not found in the Forge image");
  }
  const tmp = await fsPromises.mkdtemp(path.join(os.tmpdir(), "forge-content-tmpl-"));
  const out = path.join(tmp, "forge-ansible-content-template.tar.gz");
  const tar = await run("tar", ["-czf", out, "-C", root, "."]);
  if (tar.code !== 0 || !fs.existsSync(out)) {
    await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw new Error(tar.stderr || tar.stdout || "Failed to pack template");
  }
  const buf = await fsPromises.readFile(out);
  await fsPromises.rm(tmp, { recursive: true, force: true }).catch(() => {});
  return {
    filename: "forge-ansible-content-template.tar.gz",
    contentType: "application/gzip",
    buffer: buf,
  };
}
