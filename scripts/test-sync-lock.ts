import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runLockedStage } from "./locked-stage";
import {
  PIPELINE_LOCK_HELD_ENV,
  withPipelineLock,
} from "./sync-lock";
import { runUpdatePipeline, UPDATE_STAGES } from "./sync-all";

const root = await mkdtemp(path.join(os.tmpdir(), "r1999-roster-lock-test-"));
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
    console.log("ok: active owner rejects before callback");
  }

  for (const [name, contents] of [
    ["dead", "4321\n"],
    ["invalid", "not-a-pid\n"],
  ] as const) {
    const lockFile = path.join(root, `${name}.lock`);
    await writeFile(lockFile, contents);
    let called = false;
    await withPipelineLock(
      async () => {
        called = true;
        assert.equal(await readFile(lockFile, "utf8"), "100\n");
      },
      { lockFile, pid: 100, isProcessAlive: () => false }
    );
    assert.equal(called, true);
    assert.equal(existsSync(lockFile), false);
  }
  console.log("ok: dead and invalid stale locks are recovered");

  {
    const lockFile = path.join(root, "held", "missing.lock");
    let called = false;
    await withPipelineLock(
      async () => {
        called = true;
      },
      { lockFile, env: { [PIPELINE_LOCK_HELD_ENV]: "1" } }
    );
    assert.equal(called, true);
    assert.equal(existsSync(lockFile), false);
    console.log("ok: held marker bypasses nested acquisition");
  }

  {
    const successLock = path.join(root, "success.lock");
    await withPipelineLock(
      async () => assert.equal(existsSync(successLock), true),
      { lockFile: successLock, pid: 100 }
    );
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
    assert.equal(existsSync(failureLock), false);
    console.log("ok: success and failure release in finally");
  }

  {
    const lockFile = path.join(root, "direct.lock");
    const calls: Array<{ script: string; held: string | undefined }> = [];
    await runLockedStage("scripts/example.ts", {
      lockOptions: { lockFile, pid: 100 },
      runChild: (script, env) => {
        assert.equal(existsSync(lockFile), true);
        calls.push({ script, held: env[PIPELINE_LOCK_HELD_ENV] });
      },
    });
    assert.deepEqual(calls, [{ script: "scripts/example.ts", held: "1" }]);
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
    console.log("ok: direct stage locks before spawn and rejects overlap");
  }

  {
    const lockFile = path.join(root, "update.lock");
    const calls: Array<{ stage: string; held: string | undefined }> = [];
    await runUpdatePipeline({
      lockOptions: { lockFile, pid: 100 },
      runStage: (stage, env) => {
        assert.equal(existsSync(lockFile), true);
        calls.push({ stage, held: env[PIPELINE_LOCK_HELD_ENV] });
      },
    });
    assert.deepEqual(
      calls,
      UPDATE_STAGES.map((stage) => ({ stage, held: "1" }))
    );
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
    assert.equal(existsSync(failedLock), false);
    console.log("ok: update holds one lock, preserves order, and stops on failure");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("sync lock checks passed");
