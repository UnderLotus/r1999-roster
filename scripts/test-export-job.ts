import assert from "node:assert/strict";

import {
  createExportJob,
  type ExportJob,
  type ExportRenderer,
} from "../src/utils/export-job";

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 6; index++) await Promise.resolve();
}

function createHarness(): {
  job: ExportJob<string>;
  timers: Array<() => void>;
  downloads: Array<{ url: string; filename: string }>;
  revokedUrls: string[];
  setLoader(loader: () => Promise<ExportRenderer>): void;
  setRenderer(renderer: ExportRenderer): void;
} {
  const target = {} as HTMLElement;
  let renderer: ExportRenderer = async (_target, onProgress) => {
    onProgress({ loaded: 1, total: 1 });
    return new Blob(["jpeg"], { type: "image/jpeg" });
  };
  let loader = async (): Promise<ExportRenderer> => renderer;
  let urlSequence = 0;
  const timers: Array<() => void> = [];
  const downloads: Array<{ url: string; filename: string }> = [];
  const revokedUrls: string[] = [];

  const job = createExportJob<string>({
    waitForRender: async () => {},
    loadRenderer: () => loader(),
    getTarget: () => target,
    createObjectUrl: () => `blob:test-${++urlSequence}`,
    revokeObjectUrl: (url) => revokedUrls.push(url),
    download: (url, filename) => downloads.push({ url, filename }),
    filename: () => "reverse-1999-box-2026-08-27.jpg",
    setTimer: (callback) => {
      timers.push(callback);
      return {} as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });

  return {
    job,
    timers,
    downloads,
    revokedUrls,
    setLoader(nextLoader) {
      loader = nextLoader;
    },
    setRenderer(nextRenderer) {
      renderer = nextRenderer;
    },
  };
}

// Success publishes progress, enforces single-flight, downloads once, and
// releases the URL on the owned cleanup timer.
{
  const harness = createHarness();
  const observedProgress: string[] = [];
  harness.job.subscribe(() => {
    const progress = harness.job.getState().progress;
    if (progress) observedProgress.push(`${progress.loaded}/${progress.total}`);
  });

  assert(harness.job.start("snapshot-a"), "success: first export starts");
  assert(
    !harness.job.start("snapshot-b"),
    "single-flight: overlapping export is rejected"
  );
  assert(
    harness.job.getState().snapshot === "snapshot-a",
    "single-flight: active snapshot stays stable"
  );
  await flushAsyncWork();

  assert(harness.job.getState().status === "idle", "success: returns to idle");
  assert(harness.job.getState().snapshot === null, "success: unmounts snapshot");
  assert(observedProgress.includes("1/1"), "success: publishes image progress");
  assert(harness.downloads.length === 1, "success: downloads exactly once");
  assert(
    harness.downloads[0]?.filename === "reverse-1999-box-2026-08-27.jpg",
    "success: preserves JPEG filename behavior"
  );
  const [releaseTimer] = harness.timers;
  assert(releaseTimer, "success: schedules owned URL cleanup");
  releaseTimer();
  assert(
    harness.revokedUrls.join(",") === "blob:test-1",
    "success: releases object URL exactly once"
  );
}

// Lazy-load failure is retryable.
{
  const harness = createHarness();
  harness.setLoader(async () => {
    throw new Error("chunk failed");
  });
  harness.job.start("failed-import");
  await flushAsyncWork();

  assert(harness.job.getState().status === "error", "loader failure: reports error");
  assert(
    harness.job.getState().snapshot === null,
    "loader failure: unmounts off-screen snapshot"
  );

  harness.setLoader(async () => async () => new Blob(["retry"]));
  assert(harness.job.start("retry"), "loader failure: retry starts immediately");
  await flushAsyncWork();
  assert(harness.job.getState().status === "idle", "retry: succeeds after failure");
  harness.job.cancel();
}

// Render failure becomes retryable and leaves no render tree.
{
  const harness = createHarness();
  harness.setRenderer(async () => {
    throw new Error("image or capture failed");
  });
  harness.job.start("capture-failure");
  await flushAsyncWork();
  assert(
    harness.job.getState().status === "error",
    "image/capture failure: reports a retryable error"
  );
  const [resetError] = harness.timers;
  assert(resetError, "image/capture failure: schedules error reset");
  resetError();
  assert(
    harness.job.getState().status === "idle",
    "image/capture failure: timer resets error display"
  );
  harness.job.cancel();
}

// A Blob that resolves after cancellation never downloads.
{
  const harness = createHarness();
  const capture = deferred<Blob>();
  let captureBegun = false;
  harness.setRenderer(async () => {
    captureBegun = true;
    return capture.promise;
  });

  assert(harness.job.start("cancelled"), "cancellation: export starts");
  await flushAsyncWork();
  assert(captureBegun, "cancellation: capture is in flight");
  harness.job.cancel();
  capture.resolve(new Blob(["late"]));
  await flushAsyncWork();

  assert.equal(
    harness.downloads.length,
    0,
    "cancellation: late Blob never triggers a download"
  );
  assert(
    harness.job.getState().status === "idle" &&
      harness.job.getState().snapshot === null,
    "cancellation: abandoned attempt stays idle with no snapshot"
  );
}

console.log("export job checks passed");
