import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CACHE_TTL_MS,
  checkForUpdate,
  getUpdateCachePath,
  readPackageMetadata,
  readUpdateCache,
  getUpdateStatus,
  isUpdateAvailable,
  runUpdate,
  writeUpdateCache,
} from "../src/cli/update.js";

function registryResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("updater", () => {
  it("reads bounded package metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agency-update-"));
    const path = join(directory, "package.json");
    try {
      await writeFile(path, JSON.stringify({ name: "agency-harness", version: "0.1.0" }));
      await expect(readPackageMetadata(path)).resolves.toEqual({ name: "agency-harness", version: "0.1.0" });
      await writeFile(path, JSON.stringify({ name: 42, version: "nope" }));
      await expect(readPackageMetadata(path)).rejects.toThrow("Invalid package metadata");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("checks the latest registry version and rejects malformed responses", async () => {
    const fetched: string[] = [];
    await expect(checkForUpdate("agency-harness", {
      fetch: async (url) => {
        fetched.push(url);
        return registryResponse({ version: "1.2.4" });
      },
    })).resolves.toEqual("1.2.4");
    expect(fetched).toEqual(["https://registry.npmjs.org/agency-harness/latest"]);
    await expect(checkForUpdate("agency-harness", {
      fetch: async () => registryResponse({ version: "latest" }),
    })).rejects.toThrow("invalid version");
    await expect(checkForUpdate("agency-harness", {
      fetch: async () => new Response("x".repeat(5_000)),
    })).rejects.toThrow("size limit");
  });

  it("compares stable versions without offering downgrades", () => {
    expect(isUpdateAvailable("1.2.3", "1.2.4")).toBe(true);
    expect(isUpdateAvailable("1.2.3", "1.2.3-beta.1")).toBe(false);
    expect(isUpdateAvailable("1.2.4", "1.2.3")).toBe(false);
  });

  it("uses a fresh cache before consulting the registry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agency-update-"));
    const path = join(directory, "updates.json");
    try {
      await writeUpdateCache(path, { checkedAt: 100, version: "1.2.4" });
      const status = await getUpdateStatus(
        { name: "agency-harness", version: "1.2.3" },
        { cachePath: path, now: 101, fetch: async () => { throw new Error("must not fetch"); } },
      );
      expect(status).toEqual({
        availableVersion: "1.2.4",
        currentVersion: "1.2.3",
        updateAvailable: true,
        usedCache: true,
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("makes explicit checks fresh and read-only", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agency-update-"));
    const path = join(directory, "updates.json");
    try {
      await writeUpdateCache(path, { checkedAt: 100, version: "1.2.3" });
      const before = await readFile(path, "utf8");
      const status = await getUpdateStatus(
        { name: "agency-harness", version: "1.2.3" },
        {
          cachePath: path,
          now: 101,
          useCache: false,
          writeCache: false,
          fetch: async () => registryResponse({ version: "1.2.4" }),
        },
      );
      expect(status.availableVersion).toBe("1.2.4");
      expect(status.usedCache).toBe(false);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("throttles repeated passive checks after a registry failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agency-update-"));
    const path = join(directory, "updates.json");
    try {
      await expect(getUpdateStatus(
        { name: "agency-harness", version: "1.2.3" },
        { cachePath: path, now: 100, fetch: async () => { throw new Error("offline"); } },
      )).rejects.toThrow("offline");
      await expect(readUpdateCache(path, 101)).resolves.toEqual({ checkedAt: 100, version: null });
      const throttled = await getUpdateStatus(
        { name: "agency-harness", version: "1.2.3" },
        { cachePath: path, now: 101, fetch: async () => { throw new Error("must not fetch"); } },
      );
      expect(throttled).toMatchObject({ updateAvailable: false, usedCache: true });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("uses a bounded request timeout", async () => {
    let aborted = false;
    await expect(checkForUpdate("agency-harness", {
      timeoutMs: 1,
      fetch: async (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); });
      }),
    })).rejects.toThrow("timed out");
    expect(aborted).toBe(true);
  });

  it("reads and atomically writes a fresh bounded cache", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agency-update-"));
    const path = join(directory, "updates.json");
    try {
      await writeUpdateCache(path, { checkedAt: 100, version: "1.2.3" });
      await expect(readUpdateCache(path, 100 + CACHE_TTL_MS - 1)).resolves.toEqual({ checkedAt: 100, version: "1.2.3" });
      await expect(readUpdateCache(path, 100 + CACHE_TTL_MS)).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ checkedAt: 100, version: "1.2.3" });
      await writeFile(path, "x".repeat(5_000));
      await expect(readUpdateCache(path, 0)).resolves.toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("selects an OS user cache location", () => {
    expect(getUpdateCachePath({ XDG_CACHE_HOME: "/cache" }, "/home/user", "linux")).toBe("/cache/agency-harness/updates.json");
    expect(getUpdateCachePath({}, "/home/user", "linux")).toBe("/home/user/.cache/agency-harness/updates.json");
    expect(getUpdateCachePath({}, "/Users/user", "darwin")).toBe("/Users/user/Library/Caches/agency-harness/updates.json");
    expect(getUpdateCachePath({ LOCALAPPDATA: "C:\\Cache" }, "C:\\Users\\user", "win32")).toBe("C:\\Cache/agency-harness/updates.json");
  });

  it("runs npm explicitly without a shell", async () => {
    const calls: unknown[] = [];
    await runUpdate({
      packageName: "agency-harness",
      run: async (options) => { calls.push(options); return { exitCode: 0 }; },
    });
    expect(calls).toEqual([{
      command: "npm",
      args: [
        "install",
        "--global",
        "agency-harness@latest",
        "--registry=https://registry.npmjs.org",
        "--no-audit",
        "--no-fund",
      ],
      shell: false,
    }]);
    await expect(runUpdate({ run: async () => ({ exitCode: 1 }) })).rejects.toThrow("exit code 1");
  });
});
