import { domToJpeg } from "modern-screenshot";

import type { ExportProgress } from "./export-job";

/** 等待區域內所有圖片載入完成，回報進度 */
async function waitForImages(
  root: HTMLElement,
  onProgress?: (progress: ExportProgress) => void
): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  const total = images.length;
  let loaded = 0;

  if (total === 0) return;

  onProgress?.({ loaded: 0, total });

  await Promise.all(
    images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
          if (image.complete) done();
        });
      }

      if (image.naturalWidth === 0) {
        throw new Error(
          `圖片載入失敗：${image.currentSrc || image.src}`
        );
      }

      await image.decode().catch(() => undefined);
      loaded++;
      onProgress?.({ loaded, total });
    })
  );
}

/** 等待 ExportCanvas ready，並以既有輸出設定產生 JPEG。 */
export async function renderJpeg(
  exportElement: HTMLElement,
  onProgress?: (progress: ExportProgress) => void
): Promise<Blob> {
  await document.fonts.ready;
  await waitForImages(exportElement, onProgress);

  const dataUrl = await domToJpeg(exportElement, {
    quality: 0.92,
    backgroundColor: "#eee8da",
    scale: 1.5,
  });

  return dataURLtoBlob(dataUrl);
}

function dataURLtoBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(",");
  if (!data) throw new Error("invalid data URL");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes = atob(data);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    buf[i] = bytes.charCodeAt(i);
  }
  return new Blob([buf], { type: mime });
}
