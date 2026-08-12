import { constants } from "node:fs";
import { link, lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { InfrastructureError } from "../process/index.js";
import { ensurePrivateMetadataDirectory, readPrivateMetadataFile } from "../persistence/metadata-root.js";

interface Lease { pid: number; token: string; createdAt: number; processStartId: string }
const PROCESS_START_ID = randomUUID();
const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1_000);
const MALFORMED_LEASE_GRACE_MS = 30_000;
const MAX_LEASE_BYTES = 4 * 1024;

async function readLeaseFile(root: string, path: string): Promise<string> {
  const contents = await readPrivateMetadataFile(root, path, MAX_LEASE_BYTES);
  if (contents === null) throw Object.assign(new Error("Repository lease disappeared"), { code: "ENOENT" });
  return contents;
}

function live(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function withRepositoryLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const control = join(root, ".devagency");
  try {
    await ensurePrivateMetadataDirectory(root, control);
  } catch (cause) {
    throw new InfrastructureError("GIT_UNSAFE_PATH", "Agency metadata directory must be a private real directory", { cause });
  }
  const lock = join(control, "repository.lock");
  const token = randomUUID();
  const lease: Lease = { pid: process.pid, token, createdAt: Date.now(), processStartId: PROCESS_START_ID };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(JSON.stringify(lease), "utf8"); }
      finally { await handle.close(); }
      break;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 250) throw new InfrastructureError("GIT_CHECKPOINT_INVALID", "Could not acquire repository metadata lock", { cause });
      try {
        const observedBytes = await readLeaseFile(root, lock);
        const observed = JSON.parse(observedBytes) as Lease;
        const reusedCurrentPid = observed.pid === process.pid && observed.processStartId !== PROCESS_START_ID && observed.createdAt < PROCESS_STARTED_AT;
        if (Number.isInteger(observed.pid) && (!live(observed.pid) || reusedCurrentPid)) {
          const quarantine = `${lock}.stale-${randomUUID()}`;
          await rename(lock, quarantine);
          const movedBytes = await readLeaseFile(root, quarantine);
          const moved = JSON.parse(movedBytes) as Lease;
          if (movedBytes === observedBytes && moved.token === observed.token && (!live(moved.pid) || reusedCurrentPid)) await rm(quarantine, { force: true });
          else await link(quarantine, lock).then(() => rm(quarantine, { force: true })).catch(() => {});
          continue;
        }
      } catch {
        try {
          const malformed = await lstat(lock);
          if (Date.now() - malformed.mtimeMs > MALFORMED_LEASE_GRACE_MS) {
            const quarantine = `${lock}.malformed-${randomUUID()}`;
            await rename(lock, quarantine);
            const moved = await lstat(quarantine);
            if (Date.now() - moved.mtimeMs > MALFORMED_LEASE_GRACE_MS) await rm(quarantine, { force: true });
            else await link(quarantine, lock).then(() => rm(quarantine, { force: true })).catch(() => {});
            continue;
          }
        } catch { /* Concurrent lock publication or reclaim: retry. */ }
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
  }
  try { return await operation(); }
  finally {
    const quarantine = `${lock}.release-${randomUUID()}`;
    try {
      await rename(lock, quarantine);
      const moved = JSON.parse(await readLeaseFile(root, quarantine)) as Lease;
      if (moved.token === token) await rm(quarantine, { force: true });
      else await link(quarantine, lock).then(() => rm(quarantine, { force: true })).catch(() => {});
    } catch { /* Never unlink a lease whose token cannot be proven. */ }
  }
}
