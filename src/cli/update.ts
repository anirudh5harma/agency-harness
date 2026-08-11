import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 4 * 1024;
const MAX_REGISTRY_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export interface PackageMetadata {
  name: string;
  version: string;
}

export interface UpdateCheckOptions {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface UpdateCacheEntry {
  checkedAt: number;
  version: string | null;
}

export interface NpmRunner {
  (options: { command: string; args: readonly string[]; shell: false }): Promise<{ exitCode: number | null }>;
}

export interface RunUpdateOptions {
  packageName?: string;
  platform?: NodeJS.Platform;
  run: NpmRunner;
}

export interface UpdateStatus {
  availableVersion: string;
  currentVersion: string;
  updateAvailable: boolean;
  usedCache: boolean;
}

export interface CachedUpdateCheckOptions extends UpdateCheckOptions {
  cachePath?: string;
  now?: number;
  useCache?: boolean;
  writeCache?: boolean;
}

function isVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && SEMVER.test(value);
}

async function readBoundedText(path: string, maximumBytes: number, label: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maximumBytes) throw new Error(`${label} exceeds size limit`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function defaultPackageJsonPath(): string {
  return fileURLToPath(new URL("../../package.json", import.meta.url));
}

export async function readPackageMetadata(path = defaultPackageJsonPath()): Promise<PackageMetadata> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(path, MAX_METADATA_BYTES, "Package metadata"));
  } catch (error) {
    if (error instanceof Error && error.message.includes("size limit")) throw error;
    throw new Error("Invalid package metadata", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid package metadata");
  const name = (parsed as Record<string, unknown>).name;
  const version = (parsed as Record<string, unknown>).version;
  if (typeof name !== "string" || name === "" || !isVersion(version)) {
    throw new Error("Invalid package metadata");
  }
  return { name, version };
}

async function readRegistryJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_REGISTRY_BYTES) {
    throw new Error("Registry response exceeds size limit");
  }
  if (response.body === null) throw new Error("Registry returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_REGISTRY_BYTES) {
        await reader.cancel();
        throw new Error("Registry response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
  } catch {
    throw new Error("Registry returned invalid JSON");
  }
}

export async function checkForUpdate(
  packageName: string,
  options: UpdateCheckOptions = {},
): Promise<string> {
  if (packageName === "" || packageName.length > 214) throw new Error("Invalid package name");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error("Invalid update check timeout");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      { signal: controller.signal },
    );
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
    const payload = await readRegistryJson(response);
    const version = typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown>).version : undefined;
    if (!isVersion(version)) throw new Error("Registry returned an invalid version");
    return version;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Update check timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function getUpdateCachePath(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const root = env.XDG_CACHE_HOME
    || (platform === "win32" ? env.LOCALAPPDATA : undefined)
    || (platform === "darwin" ? join(home, "Library", "Caches") : join(home, ".cache"));
  return join(root, "agency-harness", "updates.json");
}

function parseCache(value: unknown, now: number): UpdateCacheEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { checkedAt, version } = value as Record<string, unknown>;
  if (typeof checkedAt !== "number" || !Number.isFinite(checkedAt) || checkedAt > now
      || now - checkedAt >= CACHE_TTL_MS || (version !== null && !isVersion(version))) return undefined;
  return { checkedAt, version };
}

export async function readUpdateCache(
  path = getUpdateCachePath(),
  now = Date.now(),
): Promise<UpdateCacheEntry | undefined> {
  try {
    return parseCache(JSON.parse(await readBoundedText(path, MAX_CACHE_BYTES, "Update cache")), now);
  } catch {
    return undefined;
  }
}

export async function writeUpdateCache(path: string, entry: UpdateCacheEntry): Promise<void> {
  if (!Number.isFinite(entry.checkedAt)
      || (entry.version !== null && !isVersion(entry.version))) {
    throw new Error("Invalid update cache entry");
  }
  const data = JSON.stringify(entry);
  if (Buffer.byteLength(data) > MAX_CACHE_BYTES) throw new Error("Update cache exceeds size limit");
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function parseVersion(version: string): { core: readonly number[]; prerelease: readonly string[] } {
  const withoutBuild = version.split("+", 1)[0] ?? "";
  const separator = withoutBuild.indexOf("-");
  const core = separator === -1 ? withoutBuild : withoutBuild.slice(0, separator);
  const prerelease = separator === -1 ? "" : withoutBuild.slice(separator + 1);
  return { core: core.split(".").map(Number), prerelease: prerelease === "" ? [] : prerelease.split(".") };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/u.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/u.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) return Math.sign(leftNumber - rightNumber);
    if (leftNumber !== null || rightNumber !== null) return leftNumber !== null ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(currentVersion: string, availableVersion: string): boolean {
  if (!isVersion(currentVersion) || !isVersion(availableVersion)) return false;
  return compareVersions(availableVersion, currentVersion) > 0;
}

export async function getUpdateStatus(
  metadata: PackageMetadata,
  options: CachedUpdateCheckOptions = {},
): Promise<UpdateStatus> {
  const now = options.now ?? Date.now();
  const cachePath = options.cachePath ?? getUpdateCachePath();
  const cached = options.useCache === false ? undefined : await readUpdateCache(cachePath, now);
  const usedCache = cached !== undefined;
  let availableVersion: string;
  try {
    availableVersion = cached === undefined
      ? await checkForUpdate(metadata.name, options)
      : cached.version ?? metadata.version;
  } catch (error) {
    if (!usedCache && options.writeCache !== false) {
      await writeUpdateCache(cachePath, { checkedAt: now, version: null }).catch(() => undefined);
    }
    throw error;
  }
  if (!usedCache && options.writeCache !== false) {
    await writeUpdateCache(cachePath, { checkedAt: now, version: availableVersion })
      .catch(() => undefined);
  }
  return {
    availableVersion,
    currentVersion: metadata.version,
    updateAvailable: isUpdateAvailable(metadata.version, availableVersion),
    usedCache,
  };
}

export const defaultNpmRunner: NpmRunner = async ({ command, args, shell }) => new Promise((resolve, reject) => {
  const child = spawn(command, [...args], { shell, stdio: "inherit" });
  child.once("error", reject);
  child.once("close", (exitCode) => resolve({ exitCode }));
});

export async function runUpdate(options: RunUpdateOptions): Promise<void> {
  const packageName = options.packageName ?? "agency-harness";
  const result = await options.run({
    command: (options.platform ?? process.platform) === "win32" ? "npm.cmd" : "npm",
    args: [
      "install",
      "--global",
      `${packageName}@latest`,
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
    ],
    shell: false,
  });
  if (result.exitCode !== 0) throw new Error(`npm update failed with exit code ${result.exitCode ?? "unknown"}`);
}
