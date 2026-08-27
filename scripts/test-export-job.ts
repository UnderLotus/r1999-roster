import {
  createExportJob,
  type ExportJob,
  type ExportRenderer,
} from "../src/utils/export-job";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

interface FakeTimer {
  callback: () => void;
  delayMs: number;
  handle: ReturnType<typeof setTimeout>;
}

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
  timers: FakeTimer[];
  downloads: Array<{ url: string; filename: string }>;
  revokedUrls: string[];
  setTarget(target: HTMLElement | null): void;
  setLoader(loader: () => Promise<ExportRenderer>): void;
  setRenderer(renderer: ExportRenderer): void;
  setDownload(download: (url: string, filename: string) => void): void;
} {
  let target: HTMLElement | null = {} as HTMLElement;
  let renderer: ExportRenderer = async (_target, onProgress) => {
    onProgress({ loaded: 1, total: 1 });
    return new Blob(["jpeg"], { type: "image/jpeg" });
  };
  let loader = async (): Promise<ExportRenderer> => renderer;
  let download = (url: string, filename: string): void => {
    downloads.push({ url, filename });
  };
  let urlSequence = 0;
  const timers: FakeTimer[] = [];
  const downloads: Array<{ url: string; filename: string }> = [];
  const revokedUrls: string[] = [];

  const job = createExportJob<string>({
    waitForRender: async () => {},
    loadRenderer: () => loader(),
    getTarget: () => target,
    createObjectUrl: () => `blob:test-${++urlSequence}`,
    revokeObjectUrl: (url) => revokedUrls.push(url),
    download: (url, filename) => download(url, filename),
    filename: () => "reverse-1999-box-2026-08-27.jpg",
    setTimer: (callback, delayMs) => {
      const handle = {} as ReturnType<typeof setTimeout>;
      timers.push({ callback, delayMs, handle });
      return handle;
    },
    clearTimer: () => {},
  });

  return {
    job,
    timers,
    downloads,
    revokedUrls,
    setTarget(nextTarget) {
      target = nextTarget;
    },
    setLoader(nextLoader) {
      loader = nextLoader;
    },
    setRenderer(nextRenderer) {
      renderer = nextRenderer;
    },
    setDownload(nextDownload) {
      download = nextDownload;
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
  const releaseTimer = harness.timers.find((timer) => timer.delayMs === 10000);
  assert(Boolean(releaseTimer), "success: schedules owned URL cleanup");
  releaseTimer?.callback();
  assert(
    harness.revokedUrls.join(",") === "blob:test-1",
    "success: releases object URL exactly once"
  );
}

// Lazy-load failure is retryable; forcing its cleared stale timer cannot reset
// the newer attempt.
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
  const staleReset = harness.timers.find((timer) => timer.delayMs === 3000);
  assert(Boolean(staleReset), "loader failure: schedules three-second error reset");

  harness.setLoader(async () => async () => new Blob(["retry"]));
  assert(harness.job.start("retry"), "loader failure: retry starts immediately");
  staleReset?.callback();
  assert(
    harness.job.getState().status === "exporting",
    "retry: stale error timer cannot clear newer attempt"
  );
  await flushAsyncWork();
  assert(harness.job.getState().status === "idle", "retry: succeeds after failure");
  harness.job.cancel();
}

// Every concrete dependency failure becomes retryable and leaves no render tree.
{
  const missingTarget = createHarness();
  missingTarget.setTarget(null);
  missingTarget.job.start("missing-target");
  await flushAsyncWork();
  assert(
    missingTarget.job.getState().status === "error" &&
      missingTarget.job.getState().snapshot === null,
    "missing target: fails cleanly and unmounts snapshot"
  );
  missingTarget.job.cancel();

  const captureFailure = createHarness();
  captureFailure.setRenderer(async () => {
    throw new Error("image or capture failed");
  });
  captureFailure.job.start("capture-failure");
  await flushAsyncWork();
  assert(
    captureFailure.job.getState().status === "error",
    "image/capture failure: reports a retryable error"
  );
  captureFailure.timers
    .find((timer) => timer.delayMs === 3000)
    ?.callback();
  assert(
    captureFailure.job.getState().status === "idle",
    "image/capture failure: error display resets after three seconds"
  );
  captureFailure.job.cancel();

  const downloadFailure = createHarness();
  downloadFailure.setDownload(() => {
    throw new Error("download failed");
  });
  downloadFailure.job.start("download-failure");
  await flushAsyncWork();
  assert(
    downloadFailure.job.getState().status === "error",
    "download failure: returns a retryable error state"
  );
  assert(
    downloadFailure.revokedUrls.join(",") === "blob:test-1",
    "download failure: releases created URL exactly once"
  );
  downloadFailure.job.cancel();
}

// Cancellation uses attempt identity: late callbacks from the cancelled attempt
// cannot mutate or complete a concurrently active retry.
{
  const inFlight = createHarness();
  const oldCapture = deferred<Blob>();
  const retryCapture = deferred<Blob>();
  const oldProgress: {
    current: ((progress: { loaded: number; total: number }) => void) | null;
  } = { current: null };
  const retryProgress: {
    current: ((progress: { loaded: number; total: number }) => void) | null;
  } = { current: null };
  let rendererCall = 0;
  inFlight.setRenderer(async (_target, onProgress) => {
    rendererCall++;
    if (rendererCall === 1) {
      oldProgress.current = onProgress;
      return oldCapture.promise;
    }
    retryProgress.current = onProgress;
    return retryCapture.promise;
  });

  inFlight.job.start("cancelled-old");
  await flushAsyncWork();
  inFlight.job.cancel();
  assert(
    inFlight.job.start("retry-owned"),
    "cancel/retry: retry starts after cancelling old attempt"
  );
  await flushAsyncWork();
  retryProgress.current?.({ loaded: 1, total: 4 });
  assert(
    inFlight.job.getState().status === "exporting" &&
      inFlight.job.getState().snapshot === "retry-owned" &&
      inFlight.job.getState().progress?.loaded === 1,
    "cancel/retry: retry owns the active snapshot and progress"
  );

  oldProgress.current?.({ loaded: 9, total: 9 });
  oldCapture.resolve(new Blob(["stale-old"]));
  await flushAsyncWork();
  assert(
    inFlight.job.getState().status === "exporting" &&
      inFlight.job.getState().snapshot === "retry-owned" &&
      inFlight.job.getState().progress?.loaded === 1 &&
      inFlight.job.getState().progress?.total === 4,
    "cancel/retry: old callbacks cannot overwrite retry-owned state"
  );
  assert(
    inFlight.downloads.length === 0,
    "cancel/retry: old Blob cannot trigger a download while retry is active"
  );

  retryProgress.current?.({ loaded: 4, total: 4 });
  retryCapture.resolve(new Blob(["retry"]));
  await flushAsyncWork();
  assert(
    inFlight.job.getState().status === "idle" &&
      inFlight.job.getState().snapshot === null,
    "cancel/retry: retry completes normally"
  );
  assert(
    inFlight.downloads.length === 1 &&
      inFlight.downloads[0]?.url === "blob:test-1",
    "cancel/retry: exactly one download belongs to the retry"
  );
  inFlight.job.cancel();

  const completed = createHarness();
  completed.job.start("completed");
  await flushAsyncWork();
  const releaseTimer = completed.timers.find((timer) => timer.delayMs === 10000);
  completed.job.cancel();
  releaseTimer?.callback();
  assert(
    completed.revokedUrls.join(",") === "blob:test-1",
    "cancel cleanup: URL is revoked exactly once despite stale timer"
  );
}

console.log(
  process.exitCode ? "export job checks failed" : "export job checks passed"
);
