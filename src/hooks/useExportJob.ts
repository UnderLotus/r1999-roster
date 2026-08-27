import { useEffect, useRef, useSyncExternalStore } from "react";

import {
  createExportJob,
  type ExportJob,
  type ExportJobState,
} from "../utils/export-job";

function waitForRender(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function exportFilename(): string {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `reverse-1999-box-${date.getFullYear()}-${month}-${day}.jpg`;
}

function download(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}

export interface ExportJobBinding<Snapshot>
  extends ExportJobState<Snapshot> {
  start(snapshot: Snapshot): boolean;
  targetRef: React.MutableRefObject<HTMLDivElement | null>;
}

/** React adapter for the browser export job; App only supplies a snapshot. */
export function useExportJob<Snapshot>(): ExportJobBinding<Snapshot> {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const jobRef = useRef<ExportJob<Snapshot> | null>(null);

  if (jobRef.current === null) {
    jobRef.current = createExportJob<Snapshot>({
      waitForRender,
      loadRenderer: async () => {
        const { renderJpeg } = await import("../utils/export-image");
        return renderJpeg;
      },
      getTarget: () => targetRef.current,
      createObjectUrl: (blob) => URL.createObjectURL(blob),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      download,
      filename: exportFilename,
      setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimer: (timer) => clearTimeout(timer),
    });
  }

  const job = jobRef.current;
  const state = useSyncExternalStore(
    job.subscribe,
    job.getState,
    job.getState
  );

  useEffect(() => () => job.cancel(), [job]);

  return {
    ...state,
    start: job.start,
    targetRef,
  };
}
