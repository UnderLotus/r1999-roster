import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const PIPELINE_LOCK_HELD_ENV = "R1999_ROSTER_PIPELINE_LOCK_HELD";
export const PIPELINE_LOCK_FILE = path.join(
  os.tmpdir(),
  "r1999-roster-update.lock"
);

export interface PipelineLockOptions {
  lockFile?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
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

function acquireLock(options: PipelineLockOptions): number {
  const lockFile = options.lockFile ?? PIPELINE_LOCK_FILE;
  const pid = options.pid ?? process.pid;
  const isAlive = options.isProcessAlive ?? processIsAlive;
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Cannot create roster update lock with an invalid PID");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lockFile, "wx");
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let owner = 0;
      try {
        owner = Number(readFileSync(lockFile, "utf8").trim());
      } catch {
        // Unreadable or invalid lock data is stale.
      }
      if (isAlive(owner)) {
        throw new Error(`Another roster data update is running (PID ${owner})`);
      }
      rmSync(lockFile, { force: true });
      continue;
    }

    try {
      writeFileSync(fd, `${pid}\n`);
      return fd;
    } catch (error) {
      closeSync(fd);
      rmSync(lockFile, { force: true });
      throw error;
    }
  }

  throw new Error(`Could not acquire roster update lock (${lockFile})`);
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

  const lockFile = options.lockFile ?? PIPELINE_LOCK_FILE;
  const fd = acquireLock(options);
  try {
    return await run();
  } finally {
    closeSync(fd);
    rmSync(lockFile, { force: true });
  }
}
