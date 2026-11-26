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

// Success: publishes progress, enforces single-flight, downloads once, and releases URL on timer.
{
  const harness = createHarness();
  const observedProgress: string[] = [];
  harness.job.subscribe(() => {
    const progress = harness.job.getState().progress;
    if (progress) observedProgress.push(`${progress.loaded}/${progress.total}`);
  });

  assert.equal(harness.job.start("snapshot-a"), true);
  assert.equal(harness.job.start("snapshot-b"), false, "overlapping export is rejected");
  assert.equal(harness.job.getState().snapshot, "snapshot-a");
  await flushAsyncWork();

  assert.equal(harness.job.getState().status, "idle");
  assert.equal(harness.job.getState().snapshot, null);
  assert.deepEqual(observedProgress, ["1/1"]);
  assert.deepEqual(harness.downloads, [
    { url: "blob:test-1", filename: "reverse-1999-box-2026-08-27.jpg" },
  ]);
  const [releaseTimer] = harness.timers;
  assert.ok(releaseTimer, "schedules owned URL cleanup");
  releaseTimer();
  assert.deepEqual(harness.revokedUrls, ["blob:test-1"]);
}

// Lazy-load failure reports error, unmounts snapshot, and is immediately retryable.
{
  const harness = createHarness();
  harness.setLoader(async () => {
    throw new Error("chunk failed");
  });
  harness.job.start("failed-import");
  await flushAsyncWork();

  assert.equal(harness.job.getState().status, "error");
  assert.equal(harness.job.getState().snapshot, null);

  harness.setLoader(async () => async () => new Blob(["retry"]));
  assert.equal(harness.job.start("retry"), true);
  await flushAsyncWork();
  assert.equal(harness.job.getState().status, "idle");
  harness.job.cancel();
}

// Render failure transitions to error and resets via timer.
{
  const harness = createHarness();
  harness.setRenderer(async () => {
    throw new Error("image or capture failed");
  });
  harness.job.start("capture-failure");
  await flushAsyncWork();
  assert.equal(harness.job.getState().status, "error");
  const [resetError] = harness.timers;
  assert.ok(resetError, "schedules error reset timer");
  resetError();
  assert.equal(harness.job.getState().status, "idle");
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

  assert.equal(harness.job.start("cancelled"), true);
  await flushAsyncWork();
  assert.equal(captureBegun, true);
  harness.job.cancel();
  capture.resolve(new Blob(["late"]));
  await flushAsyncWork();

  assert.equal(harness.downloads.length, 0, "late Blob never triggers a download");
  assert.equal(harness.job.getState().status, "idle");
  assert.equal(harness.job.getState().snapshot, null);
}

console.log("Export job checks passed.");
