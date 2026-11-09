import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runLockedStage } from "./locked-stage";
import {
  PIPELINE_LOCK_HELD_ENV,
  withPipelineLock,
} from "./sync-lock";
import { runUpdatePipeline } from "./sync-all";

const root = await mkdtemp(path.join(os.tmpdir(), "r1999-roster-lock-test-"));

function claimFiles(lockFile: string): string[] {
  const prefix = `${path.basename(lockFile)}.claim-`;
  return readdirSync(path.dirname(lockFile), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => path.join(path.dirname(lockFile), entry.name));
}

try {
  {
    const lockFile = path.join(root, "active.lock");
    await writeFile(lockFile, "4321\n");
    let called = false;
    await assert.rejects(
      () =>
        withPipelineLock(
          async () => {
            called = true;
          },
          { lockFile, pid: 100, isProcessAlive: () => true }
        ),
      /Another roster data update is running \(PID 4321\)/
    );
    assert.equal(called, false);
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), true);
    console.log("ok: active owner rejects before callback");
  }

  {
    const lockFile = path.join(root, "dead.lock");
    await writeFile(lockFile, "4321\n");
    let called = false;
    await withPipelineLock(
      async () => {
        called = true;
        const claims = claimFiles(lockFile);
        assert.equal(claims.length, 1);
        assert.equal(
          (await readFile(claims[0]!, "utf8")).split(/\s+/)[0],
          "100"
        );
      },
      { lockFile, pid: 100, isProcessAlive: () => false }
    );
    assert.equal(called, true);
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), false);
    console.log("ok: dead stale lock is recovered once");
  }

  {
    const successLock = path.join(root, "success.lock");
    await withPipelineLock(
      async () => assert.equal(claimFiles(successLock).length, 1),
      { lockFile: successLock, pid: 100 }
    );
    assert.equal(claimFiles(successLock).length, 0);
    assert.equal(existsSync(successLock), false);

    const failureLock = path.join(root, "failure.lock");
    await assert.rejects(
      () =>
        withPipelineLock(
          async () => {
            throw new Error("stage failed");
          },
          { lockFile: failureLock, pid: 100 }
        ),
      /stage failed/
    );
    assert.equal(claimFiles(failureLock).length, 0);
    assert.equal(existsSync(failureLock), false);
    console.log("ok: success and failure release in finally");
  }

  {
    const lockFile = path.join(root, "direct.lock");
    const calls: Array<{ script: string; held: string | undefined }> = [];
    await runLockedStage("scripts/example.ts", {
      lockOptions: { lockFile, pid: 100 },
      runChild: (script, env) => {
        assert.equal(claimFiles(lockFile).length, 1);
        calls.push({ script, held: env[PIPELINE_LOCK_HELD_ENV] });
      },
    });
    assert.deepEqual(calls, [{ script: "scripts/example.ts", held: "1" }]);
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), false);

    await writeFile(lockFile, "4321\n");
    let spawned = false;
    await assert.rejects(
      () =>
        runLockedStage("scripts/example.ts", {
          lockOptions: { lockFile, isProcessAlive: () => true },
          runChild: () => {
            spawned = true;
          },
        }),
      /Another roster data update is running/
    );
    assert.equal(spawned, false);
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), true);
    console.log("ok: direct stage locks before spawn and rejects overlap");
  }

  {
    const lockFile = path.join(root, "update.lock");
    const calls: Array<{ stage: string; held: string | undefined }> = [];
    await runUpdatePipeline({
      lockOptions: { lockFile, pid: 100 },
      runStage: (stage, env) => {
        assert.equal(claimFiles(lockFile).length, 1);
        calls.push({ stage, held: env[PIPELINE_LOCK_HELD_ENV] });
      },
    });
    assert.deepEqual(
      calls,
      ["sync", "build:characters", "sync:wiki", "build:names", "sync:release"]
        .map((stage) => ({ stage, held: "1" }))
    );
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), false);

    const failedLock = path.join(root, "update-failure.lock");
    const failedCalls: string[] = [];
    await assert.rejects(
      () =>
        runUpdatePipeline({
          lockOptions: { lockFile: failedLock, pid: 100 },
          runStage: (stage) => {
            failedCalls.push(stage);
            if (stage === "build:characters") throw new Error("child failed");
          },
        }),
      /child failed/
    );
    assert.deepEqual(failedCalls, ["sync", "build:characters"]);
    assert.equal(claimFiles(failedLock).length, 0);
    assert.equal(existsSync(failedLock), false);
    console.log("ok: update holds one lock, preserves order, and stops on failure");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("sync lock checks passed");
