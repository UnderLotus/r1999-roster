import { domToJpeg } from "modern-screenshot";

/** 等待區域內所有圖片載入完成（spec §24.3） */
async function waitForImages(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));

  await Promise.all(
    images.map(async (image) => {
      if (!image.complete) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          image.addEventListener("load", done, { once: true });
          image.addEventListener("error", done, { once: true });
          // 註冊後再檢查一次，避免漏接事件
          if (image.complete) done();
        });
      }

      // 載入失敗（broken image）時 naturalWidth 為 0，直接報錯避免缺圖輸出
      if (image.naturalWidth === 0) {
        throw new Error(`圖片載入失敗：${image.currentSrc || image.src}`);
      }

      await image.decode().catch(() => undefined);
    })
  );
}

function getDateString(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${mm}${dd}`;
}

/** 匯出 ExportCanvas 為 JPG 並下載（spec §24） */
export async function exportJpeg(exportElement: HTMLElement): Promise<void> {
  await document.fonts.ready;
  await waitForImages(exportElement);

  const dataUrl = await domToJpeg(exportElement, {
    quality: 0.92,
    backgroundColor: "#eee8da",
    scale: 1,
  });

  const anchor = document.createElement("a");
  const blob = dataURLtoBlob(dataUrl);
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `reverse-1999-box-${getDateString()}.jpg`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 釋放 object URL（延遲確保下載觸發）
  setTimeout(() => URL.revokeObjectURL(anchor.href), 100);
}

function dataURLtoBlob(dataUrl: string): Blob {
  const [header, data] = dataUrl.split(",");
  const mime = header.match(/:(.*?);/)?.[1] ?? "image/jpeg";
  const bytes = atob(data);
  const buf = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    buf[i] = bytes.charCodeAt(i);
  }
  return new Blob([buf], { type: mime });
}
