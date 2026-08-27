import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  heldPipelineEnvironment,
  type PipelineLockOptions,
  withPipelineLock,
} from "./sync-lock";

export interface LockedStageOptions {
  env?: NodeJS.ProcessEnv;
  lockOptions?: PipelineLockOptions;
  runChild?: (script: string, env: NodeJS.ProcessEnv) => void;
}

function runTypeScriptChild(script: string, env: NodeJS.ProcessEnv): void {
  execFileSync(process.execPath, ["--import", "tsx", script], {
    stdio: "inherit",
    env,
  });
}

export async function runLockedStage(
  script: string,
  options: LockedStageOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  await withPipelineLock(
    async () =>
      (options.runChild ?? runTypeScriptChild)(
        script,
        heldPipelineEnvironment(env)
      ),
    { ...options.lockOptions, env }
  );
}

function childExitCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    Number.isInteger(error.status) &&
    Number(error.status) > 0
  ) {
    return Number(error.status);
  }
  return 1;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  const script = process.argv[2];
  if (!script || process.argv.length !== 3) {
    console.error("Usage: tsx scripts/locked-stage.ts <script.ts>");
    process.exitCode = 2;
  } else {
    void runLockedStage(script).catch((error) => {
      console.error(error);
      process.exitCode = childExitCode(error);
    });
  }
}
