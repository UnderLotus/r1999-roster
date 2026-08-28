import { randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIPELINE_LOCK_HELD_ENV = "R1999_ROSTER_PIPELINE_LOCK_HELD";
export const PIPELINE_LOCK_FILE = path.join(
  os.tmpdir(),
  "r1999-roster-update.lock"
);

const CLAIM_MARKER = ".claim-";

export interface PipelineLockOptions {
  lockFile?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
}

interface LockHandle {
  claimFile: string;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function isValidPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

function claimPrefix(lockFile: string): string {
  return `${path.basename(lockFile)}${CLAIM_MARKER}`;
}

function listClaimFiles(lockFile: string): string[] {
  const prefix = claimPrefix(lockFile);
  return readdirSync(path.dirname(lockFile), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        !entry.name.endsWith(".tmp")
    )
    .map((entry) => path.join(path.dirname(lockFile), entry.name));
}

function readOwner(lockFile: string): number | undefined {
  try {
    const firstLine = readFileSync(lockFile, "utf8").trim().split(/\s+/)[0];
    const owner = Number(firstLine);
    return isValidPid(owner) ? owner : 0;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function removeClaim(handle: LockHandle): void {
  rmSync(handle.claimFile, { force: true });
}

function createClaim(lockFile: string, pid: number): LockHandle {
  const token = randomUUID();
  const claimFile = path.join(
    path.dirname(lockFile),
    `${path.basename(lockFile)}${CLAIM_MARKER}${token}`
  );
  const tempFile = `${claimFile}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tempFile, "wx");
    writeFileSync(fd, `${pid}\n${token}\n`);
    closeSync(fd);
    fd = undefined;
    renameSync(tempFile, claimFile);
    return { claimFile };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tempFile, { force: true });
    rmSync(claimFile, { force: true });
    throw error;
  }
}

function acquireLock(options: PipelineLockOptions): LockHandle {
  const lockFile = options.lockFile ?? PIPELINE_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  if (!isValidPid(pid)) {
    throw new Error("Cannot create roster update lock with an invalid PID");
  }

  const handle = createClaim(lockFile, pid);
  try {
    const legacyOwner = readOwner(lockFile);
    if (legacyOwner !== undefined) {
      if (legacyOwner !== 0 && isAlive(legacyOwner)) {
        throw new Error(`Another roster data update is running (PID ${legacyOwner})`);
      }
      // New contenders never publish at this legacy path. It is safe to remove
      // a dead pre-claim lock without risking a successor claim file.
      rmSync(lockFile, { force: true });
    }

    let activeOwner: number | undefined;
    for (const claimFile of listClaimFiles(lockFile)) {
      if (claimFile === handle.claimFile) continue;
      const owner = readOwner(claimFile);
      if (owner === undefined) continue;
      if (owner !== 0 && isAlive(owner)) {
        activeOwner ??= owner;
      } else {
        // Every claim path contains a fresh UUID and is never reused by a new
        // contender, so stale cleanup cannot unlink a successor's claim.
        rmSync(claimFile, { force: true });
      }
    }

    if (activeOwner !== undefined) {
      throw new Error(
        `Another roster data update is running (PID ${activeOwner})`
      );
    }
    return handle;
  } catch (error) {
    removeClaim(handle);
    throw error;
  }
}

export function heldPipelineEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return { ...env, [PIPELINE_LOCK_HELD_ENV]: "1" };
}

export async function withPipelineLock<T>(
  run: () => Promise<T>,
  options: PipelineLockOptions = {}
): Promise<T> {
  const env = options.env ?? process.env;
  if (env[PIPELINE_LOCK_HELD_ENV] === "1") return run();

  const handle = acquireLock(options);
  try {
    return await run();
  } finally {
    removeClaim(handle);
  }
}
