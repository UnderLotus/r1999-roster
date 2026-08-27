export interface ExportProgress {
  loaded: number;
  total: number;
}

export type ExportStatus = "idle" | "exporting" | "error";

export interface ExportJobState<Snapshot> {
  status: ExportStatus;
  progress: ExportProgress | null;
  snapshot: Snapshot | null;
}

export type ExportRenderer = (
  target: HTMLElement,
  onProgress: (progress: ExportProgress) => void
) => Promise<Blob>;

export interface ExportJobDependencies {
  waitForRender(): Promise<void>;
  loadRenderer(): Promise<ExportRenderer>;
  getTarget(): HTMLElement | null;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
  download(url: string, filename: string): void;
  filename(): string;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

export interface ExportJob<Snapshot> {
  getState(): ExportJobState<Snapshot>;
  subscribe(listener: () => void): () => void;
  start(snapshot: Snapshot): boolean;
  cancel(): void;
}

const ERROR_RESET_DELAY_MS = 3000;
const OBJECT_URL_RELEASE_DELAY_MS = 10000;

/** Owns one export attempt at a time, including all late work and resources. */
export function createExportJob<Snapshot>(
  dependencies: ExportJobDependencies
): ExportJob<Snapshot> {
  let state: ExportJobState<Snapshot> = {
    status: "idle",
    progress: null,
    snapshot: null,
  };
  let attempt = 0;
  let errorTimer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();
  const objectUrlTimers = new Map<
    string,
    ReturnType<typeof setTimeout> | null
  >();

  const publish = (next: ExportJobState<Snapshot>): void => {
    state = next;
    for (const listener of listeners) listener();
  };

  const clearErrorTimer = (): void => {
    if (errorTimer === null) return;
    dependencies.clearTimer(errorTimer);
    errorTimer = null;
  };

  const releaseObjectUrl = (url: string): void => {
    if (!objectUrlTimers.has(url)) return;
    const timer = objectUrlTimers.get(url);
    if (timer !== null && timer !== undefined) dependencies.clearTimer(timer);
    objectUrlTimers.delete(url);
    dependencies.revokeObjectUrl(url);
  };

  const releaseAllObjectUrls = (): void => {
    for (const url of [...objectUrlTimers.keys()]) releaseObjectUrl(url);
  };

  const scheduleObjectUrlRelease = (url: string): void => {
    const timer = dependencies.setTimer(
      () => releaseObjectUrl(url),
      OBJECT_URL_RELEASE_DELAY_MS
    );
    objectUrlTimers.set(url, timer);
  };

  const isCurrent = (id: number): boolean =>
    state.status === "exporting" && attempt === id;

  const fail = (id: number): void => {
    if (!isCurrent(id)) return;
    publish({ status: "error", progress: null, snapshot: null });
    errorTimer = dependencies.setTimer(() => {
      errorTimer = null;
      if (attempt !== id || state.status !== "error") return;
      publish({ status: "idle", progress: null, snapshot: null });
    }, ERROR_RESET_DELAY_MS);
  };

  const run = async (id: number): Promise<void> => {
    try {
      await dependencies.waitForRender();
      if (!isCurrent(id)) return;

      const renderer = await dependencies.loadRenderer();
      if (!isCurrent(id)) return;

      const target = dependencies.getTarget();
      if (!target) throw new Error("找不到匯出渲染目標");

      const blob = await renderer(target, (progress) => {
        if (!isCurrent(id)) return;
        publish({ ...state, progress });
      });
      if (!isCurrent(id)) return;

      const url = dependencies.createObjectUrl(blob);
      objectUrlTimers.set(url, null);
      try {
        dependencies.download(url, dependencies.filename());
        scheduleObjectUrlRelease(url);
      } catch (error) {
        releaseObjectUrl(url);
        throw error;
      }

      publish({ status: "idle", progress: null, snapshot: null });
    } catch {
      fail(id);
    }
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start(snapshot) {
      if (state.status === "exporting") return false;
      clearErrorTimer();
      const id = ++attempt;
      publish({ status: "exporting", progress: null, snapshot });
      void run(id);
      return true;
    },
    cancel() {
      ++attempt;
      clearErrorTimer();
      releaseAllObjectUrls();
      if (
        state.status !== "idle" ||
        state.progress !== null ||
        state.snapshot !== null
      ) {
        publish({ status: "idle", progress: null, snapshot: null });
      }
    },
  };
}
