import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { runLockedStage } from "./locked-stage";
import {
  PIPELINE_LOCK_HELD_ENV,
  withPipelineLock,
} from "./sync-lock";
import { runUpdatePipeline, UPDATE_STAGES } from "./sync-all";

const root = await mkdtemp(path.join(os.tmpdir(), "r1999-roster-lock-test-"));

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await delay(10);
  }
}

async function waitForEntryOrExit(
  file: string,
  child: ChildProcess,
  timeoutMs = 5000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && child.exitCode === null) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${file} or child exit`);
    }
    await delay(10);
  }
  return existsSync(file);
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

function claimFiles(lockFile: string): string[] {
  const prefix = `${path.basename(lockFile)}.claim-`;
  return readdirSync(path.dirname(lockFile), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
    .map((entry) => path.join(path.dirname(lockFile), entry.name));
}

type RaceChildFixture = {
  role: "stale-lock-contender" | "replacement-contender";
  lockFile: string;
  enteredFile: string;
  ownReleaseFile: string;
  ownPidFile: string;
  otherPidFile: string;
  pauseAfterFirstLivenessProbe?: {
    readyFile: string;
    releaseFile: string;
  };
};

const raceChildScript = path.join(root, "lock-race-child.mts");
await writeFile(
  raceChildScript,
  `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { withPipelineLock } from ${JSON.stringify(path.resolve("scripts/sync-lock.ts"))};

type RaceChildFixture = {
  role: "stale-lock-contender" | "replacement-contender";
  lockFile: string;
  enteredFile: string;
  ownReleaseFile: string;
  ownPidFile: string;
  otherPidFile: string;
  pauseAfterFirstLivenessProbe?: {
    readyFile: string;
    releaseFile: string;
  };
};

const fixture = JSON.parse(process.argv[2]!) as RaceChildFixture;
const waitCell = new Int32Array(new SharedArrayBuffer(4));
let firstLivenessProbe = fixture.role === "stale-lock-contender";
writeFileSync(fixture.ownPidFile, String(process.pid));

async function waitForFile(file: string): Promise<void> {
  while (!existsSync(file)) await delay(5);
}

try {
  await withPipelineLock(
    async () => {
      writeFileSync(fixture.enteredFile, String(process.pid));
      await waitForFile(fixture.ownReleaseFile);
    },
    {
      lockFile: fixture.lockFile,
      pid: process.pid,
      isProcessAlive: (pid) => {
        if (firstLivenessProbe) {
          firstLivenessProbe = false;
          if (!fixture.pauseAfterFirstLivenessProbe) {
            throw new Error("stale-lock contender requires a pause fixture");
          }
          writeFileSync(
            fixture.pauseAfterFirstLivenessProbe.readyFile,
            String(process.pid)
          );
          while (
            !existsSync(fixture.pauseAfterFirstLivenessProbe.releaseFile)
          ) {
            Atomics.wait(waitCell, 0, 0, 10);
          }
          return false;
        }
        return (
          Number(readFileSync(fixture.otherPidFile, "utf8").trim()) === pid
        );
      },
    }
  );
  process.exitCode = 0;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}`
);

async function runStaleRecoveryRace(): Promise<void> {
  const raceRoot = path.join(root, "race");
  const lockFile = path.join(raceRoot, "shared.lock");
  const staleReady = path.join(raceRoot, "stale-ready");
  const staleRelease = path.join(raceRoot, "stale-release");
  const staleEntered = path.join(raceRoot, "stale-entered");
  const replacementEntered = path.join(raceRoot, "replacement-entered");
  const staleOwnRelease = path.join(raceRoot, "stale-own-release");
  const replacementOwnRelease = path.join(raceRoot, "replacement-own-release");
  const stalePid = path.join(raceRoot, "stale-pid");
  const replacementPid = path.join(raceRoot, "replacement-pid");
  await mkdir(raceRoot);
  await writeFile(lockFile, "2147483647\n");

  const childArgs = (fixture: RaceChildFixture) => [
    "--import",
    "tsx/esm",
    raceChildScript,
    JSON.stringify(fixture),
  ];
  let staleLockContender: ChildProcess | undefined;
  let replacementContender: ChildProcess | undefined;
  try {
    staleLockContender = spawn(
      process.execPath,
      childArgs({
        role: "stale-lock-contender",
        lockFile,
        enteredFile: staleEntered,
        ownReleaseFile: staleOwnRelease,
        ownPidFile: stalePid,
        otherPidFile: replacementPid,
        pauseAfterFirstLivenessProbe: {
          readyFile: staleReady,
          releaseFile: staleRelease,
        },
      }),
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] }
    );
    await waitForFile(staleReady);
    await waitForFile(stalePid);

    replacementContender = spawn(
      process.execPath,
      childArgs({
        role: "replacement-contender",
        lockFile,
        enteredFile: replacementEntered,
        ownReleaseFile: replacementOwnRelease,
        ownPidFile: replacementPid,
        otherPidFile: stalePid,
      }),
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] }
    );
    await waitForFile(replacementPid);
    const replacementHasEntered = await waitForEntryOrExit(
      replacementEntered,
      replacementContender
    );

    await writeFile(staleRelease, "go");
    const staleHasEntered = await waitForEntryOrExit(
      staleEntered,
      staleLockContender
    );
    if (staleHasEntered) await writeFile(staleOwnRelease, "go");
    if (replacementHasEntered) await writeFile(replacementOwnRelease, "go");
    const [replacementCode, staleCode] = await Promise.all([
      waitForExit(replacementContender),
      waitForExit(staleLockContender),
    ]);

    assert.ok(
      replacementHasEntered || staleHasEntered,
      `race had no owner (replacement=${replacementCode}, stale=${staleCode})`
    );
    assert.equal(
      replacementHasEntered && staleHasEntered,
      false,
      `stale recovery admitted concurrent owners (replacement=${replacementCode}, stale=${staleCode})`
    );
    assert.equal(claimFiles(lockFile).length, 0);
    assert.equal(existsSync(lockFile), false);
    console.log("ok: stale recovery never admits concurrent owners");
  } finally {
    for (const child of [replacementContender, staleLockContender]) {
      if (child && child.exitCode === null) child.kill("SIGKILL");
    }
    await Promise.all(
      [replacementContender, staleLockContender]
        .filter((child): child is ChildProcess => Boolean(child))
        .map((child) => waitForExit(child).catch(() => null))
    );
  }
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
  }
  console.log("ok: dead and invalid stale locks are recovered");

  await runStaleRecoveryRace();

  {
    const lockFile = path.join(root, "late-owner.lock");
    const activeClaim = path.join(
      path.dirname(lockFile),
      `${path.basename(lockFile)}.claim-zzzz`
    );
    await writeFile(activeClaim, "4321\nzzzz\n");
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
    assert.deepEqual(claimFiles(lockFile), [activeClaim]);
    assert.equal(existsSync(activeClaim), true);
    console.log("ok: live claim rejects late contender");
  }

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
      UPDATE_STAGES.map((stage) => ({ stage, held: "1" }))
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
