import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  heldPipelineEnvironment,
  type PipelineLockOptions,
  withPipelineLock,
} from "./sync-lock";

export const UPDATE_STAGES = [
  "sync",
  "build:characters",
  "sync:wiki",
  "build:names",
  "sync:release",
] as const;

export interface UpdatePipelineOptions {
  env?: NodeJS.ProcessEnv;
  lockOptions?: PipelineLockOptions;
  runStage?: (stage: string, env: NodeJS.ProcessEnv) => void;
}

function runNpmStage(stage: string, env: NodeJS.ProcessEnv): void {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npm, ["run", stage], { stdio: "inherit", env });
}

export async function runUpdatePipeline(
  options: UpdatePipelineOptions = {}
): Promise<void> {
  const env = options.env ?? process.env;
  await withPipelineLock(
    async () => {
      const childEnv = heldPipelineEnvironment(env);
      for (const stage of UPDATE_STAGES) {
        (options.runStage ?? runNpmStage)(stage, childEnv);
      }
    },
    { ...options.lockOptions, env }
  );
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  void runUpdatePipeline().catch((error) => {
    console.error(error);
    process.exitCode =
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      Number.isInteger(error.status) &&
      Number(error.status) > 0
        ? Number(error.status)
        : 1;
  });
}
