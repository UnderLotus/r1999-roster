import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NameSourceError,
  type NameSourceSnapshot,
  validateNameSourceSnapshot,
} from "./name-source";

export const NAME_SOURCE_CACHE_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "data/name-source-cache.json"
);

export interface FileReplaceOperations {
  exists(file: string): boolean;
  rename(from: string, to: string): Promise<void>;
  remove(file: string): Promise<void>;
}

export interface FileReplaceResult {
  committed: true;
  /** Present only when commit succeeded but old-backup cleanup failed. */
  backupPath?: string;
}

const defaultReplaceOperations: FileReplaceOperations = {
  exists: existsSync,
  rename,
  remove: (file) => rm(file, { force: true }),
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function failBeforeCommit(options: {
  primaryError: unknown;
  staging: string;
  target: string;
  backup: string;
  oldMoved: boolean;
  operations: FileReplaceOperations;
}): Promise<never> {
  let recoveryPath: string | undefined;
  if (options.oldMoved) {
    try {
      await options.operations.rename(options.backup, options.target);
    } catch {
      recoveryPath = options.backup;
    }
  }
  try {
    await options.operations.remove(options.staging);
  } catch {
    // Staging cleanup is best-effort; target/backup ownership is reported below.
  }

  const recovery = recoveryPath
    ? `automatic restore failed; previous cache remains at ${recoveryPath}`
    : options.oldMoved
      ? "previous cache restored"
      : "previous cache remained at target";
  throw new NameSourceError(
    "cache",
    "name source cache",
    `cache install failed before commit: ${errorText(options.primaryError)}; ${recovery}`,
    { cause: options.primaryError, recoveryPath }
  );
}

/**
 * Atomically commit staging. A pre-commit failure restores the old target once;
 * after staging→target commits, backup cleanup is best-effort.
 */
export async function replaceFileWithRollback(
  staging: string,
  target: string,
  operations: FileReplaceOperations = defaultReplaceOperations
): Promise<FileReplaceResult> {
  const backup = `${target}.backup-${randomUUID()}`;
  let oldMoved = false;

  if (operations.exists(target)) {
    try {
      await operations.rename(target, backup);
      oldMoved = true;
    } catch (error) {
      return failBeforeCommit({
        primaryError: error,
        staging,
        target,
        backup,
        oldMoved: false,
        operations,
      });
    }
  }

  try {
    await operations.rename(staging, target);
  } catch (error) {
    return failBeforeCommit({
      primaryError: error,
      staging,
      target,
      backup,
      oldMoved,
      operations,
    });
  }

  if (!oldMoved) return { committed: true };
  try {
    await operations.remove(backup);
    return { committed: true };
  } catch {
    return { committed: true, backupPath: backup };
  }
}

export function serializeNameSourceSnapshot(snapshot: NameSourceSnapshot): string {
  validateNameSourceSnapshot(snapshot);
  return JSON.stringify(snapshot, null, 2) + "\n";
}

export async function loadNameSourceCache(
  file = NAME_SOURCE_CACHE_FILE
): Promise<NameSourceSnapshot> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new NameSourceError(
      "cache",
      "name source cache",
      `name source cache is unavailable: ${file}`,
      { cause: error }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new NameSourceError(
      "parse",
      "name source cache",
      "name source cache is not valid JSON",
      { cause: error }
    );
  }
  validateNameSourceSnapshot(value);
  return value;
}

export async function installNameSourceCache(
  snapshot: NameSourceSnapshot,
  file = NAME_SOURCE_CACHE_FILE
): Promise<FileReplaceResult> {
  const serialized = serializeNameSourceSnapshot(snapshot);
  try {
    await mkdir(path.dirname(file), { recursive: true });
  } catch (error) {
    throw new NameSourceError(
      "cache",
      "name source cache",
      `failed to create cache directory for ${file}`,
      { cause: error }
    );
  }

  const staging = `${file}.staging-${randomUUID()}`;
  try {
    await writeFile(staging, serialized, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    try {
      await rm(staging, { force: true });
    } catch {
      // Best-effort cleanup; no cache target was touched.
    }
    throw new NameSourceError(
      "cache",
      "name source cache",
      `failed to stage name source cache: ${errorText(error)}`,
      { cause: error }
    );
  }

  return replaceFileWithRollback(staging, file);
}
