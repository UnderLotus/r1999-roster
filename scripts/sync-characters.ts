/**
 * 手動增量同步角色資料與圖片。
 *
 * 資料來源：
 *   - 角色列表頁（Jina Reader）：一次取得全部角色（ID、名稱、頭像縮圖 URL）
 *   - api.php（Jina Reader 代理）：動態分批查詢 Portrait-{id}.webp 立繪原圖 URL
 * 圖片下載：
 *   - scripts/download-images.py（curl_cffi 模擬 Chrome TLS 指紋，繞過 Cloudflare）
 *
 * 執行：npm run sync
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character, SyncSummary } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ASSETS_DIR = path.join(ROOT, "public/assets/characters");
const DOWNLOAD_SCRIPT = path.join(__dirname, "download-images.py");

const JINA_PREFIX = "https://r.jina.ai/";
const LIST_URL =
  "https://res1999.huijiwiki.com/wiki/%E8%A7%92%E8%89%B2%E5%88%97%E8%A1%A8";
const API_URL = "https://res1999.huijiwiki.com/api.php";

/** Jina 代理的 URL 長度限制：實測批次 50 成功、60 失敗 */
const PORTRAIT_BATCH_SIZE = 50;
const USER_AGENT = "Mozilla/5.0";

interface SourceCharacter {
  id: string;
  name: string;
  pageUrl: string;
  avatarThumbUrl: string;
}

async function fetchJina(url: string): Promise<string> {
  // 用子程序跑 curl，避免 Node 的 TLS 指紋被 Jina 擋（實測 curl 可過）
  const curl = execFileSync(
    "curl",
    ["-sL", "-m", "60", "-A", USER_AGENT, `${JINA_PREFIX}${url}`],
    { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 }
  );
  return curl;
}

/** 解析角色列表頁 markdown，取得全部角色 */
function parseCharacterList(markdown: string): SourceCharacter[] {
  // 格式（每行一個角色）：
  // [![Image N: Headicon large-314901.png](縮圖URL)](角色頁URL "角色名稱")
  const lineRe =
    /\[!\[Image \d+: Headicon large-(\d+)\.png\]\((https:\/\/huiji-thumb\.huijistatic\.com\/[^)]+)\)\]\((https:\/\/res1999\.huijiwiki\.com\/wiki\/[^)]+)\s+"([^"]+)"\)/g;

  const characters: SourceCharacter[] = [];
  let match: RegExpExecArray | null;
  while ((match = lineRe.exec(markdown)) !== null) {
    const [, id, avatarThumbUrl, pageUrl, name] = match;
    characters.push({ id, name, pageUrl, avatarThumbUrl });
  }
  return characters;
}

/** 從縮圖 URL 推導頭像原圖 URL（去掉 /thumb/ 與尺寸前綴） */
function deriveAvatarOriginalUrl(thumbUrl: string): string {
  // https://huiji-thumb.../uploads/thumb/{a}/{ab}/{file}/{size}px-{file}
  // → https://huiji-public.../uploads/{a}/{ab}/{file}
  const m = thumbUrl.match(
    /\/uploads\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/([^/]+)\/\d+px-\3$/
  );
  if (!m) {
    throw new Error(`無法解析頭像縮圖 URL: ${thumbUrl}`);
  }
  const [, a, ab, filename] = m;
  return `https://huiji-public.huijistatic.com/res1999/uploads/${a}/${ab}/${filename}`;
}

/** 動態分批查詢立繪原圖 URL（批次 50 上限） */
async function fetchPortraitUrls(
  ids: string[]
): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  for (let i = 0; i < ids.length; i += PORTRAIT_BATCH_SIZE) {
    const batch = ids.slice(i, i + PORTRAIT_BATCH_SIZE);
    const titles = batch
      .map((id) => `File:Portrait-${id}.webp`)
      .join("|");
    const url =
      `${API_URL}?action=query&titles=${encodeURIComponent(titles)}` +
      `&prop=imageinfo&iiprop=url&format=json`;

    const raw = await fetchJina(url);
    const jsonStart = raw.indexOf("{");
    if (jsonStart < 0) {
      throw new Error(`api.php 回傳非 JSON（批次 ${i / PORTRAIT_BATCH_SIZE + 1}）`);
    }
    const data = JSON.parse(raw.slice(jsonStart)) as {
      query?: { pages?: Record<string, { imageinfo?: { url?: string }[] }> };
    };
    const pages = data.query?.pages ?? {};
    for (const page of Object.values(pages)) {
      const imageUrl = page.imageinfo?.[0]?.url;
      if (imageUrl) {
        const m = imageUrl.match(/Portrait-(\d+)\.webp$/);
        if (m) result.set(m[1], imageUrl);
      }
    }
  }
  return result;
}

async function downloadImages(
  items: {
    id: string;
    full: string;
    avatar: string;
    outputDir: string;
  }[]
): Promise<{ succeeded: string[]; failed: Record<string, string> }> {
  const input = JSON.stringify(items);
  const python = process.env.PYTHON_BIN ?? "python3";
  const out = execFileSync(python, [DOWNLOAD_SCRIPT], {
    input,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = JSON.parse(out) as {
    succeeded?: string[];
    failed?: Record<string, string>;
    error?: string;
  };
  if (result.error) {
    throw new Error(result.error);
  }
  return {
    succeeded: result.succeeded ?? [],
    failed: result.failed ?? {},
  };
}

function loadExisting(): Character[] {
  if (!existsSync(DATA_FILE)) return [];
  return JSON.parse(readFileSync(DATA_FILE, "utf-8")) as Character[];
}

function saveAll(characters: Character[]): void {
  writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2) + "\n", "utf-8");
}

function printSummary(s: SyncSummary): void {
  console.log(`Existing characters: ${s.existing}`);
  console.log(`Found from source: ${s.foundFromSource}`);
  console.log(`New characters added: ${s.newCharacters}`);
  console.log(`Skipped existing: ${s.skipped}`);
  console.log(`Failed images: ${s.failedImages}`);
  if (s.failedCharacters.length > 0) {
    console.log(`Failed characters: ${s.failedCharacters.join(", ")}`);
  }
}

async function main(): Promise<void> {
  const existing = loadExisting();
  const existingIds = new Set(existing.map((c) => c.id));
  console.log(`讀取現有角色: ${existing.length} 名`);

  // 1. 抓列表頁並解析
  console.log("抓取角色列表頁 (Jina Reader)...");
  const listMarkdown = await fetchJina(LIST_URL);
  const source = parseCharacterList(listMarkdown);
  console.log(`來源角色: ${source.length} 名`);

  // 數量閘門：解析結果明顯少於既有資料時，警告但不中斷
  const ratioOk = source.length >= existing.length * 0.8;
  if (existing.length > 0 && !ratioOk) {
    console.warn(
      `⚠ 來源角色數 (${source.length}) 明顯少於既有角色數 (${existing.length})，` +
        `可能來源格式已變動，請手動確認`
    );
  }

  // 2. 比對，找出新增（JSON 中已存在「且」圖片資料夾存在才算既有）
  //    避免「JSON 有資料但圖片缺失」時被錯誤跳過
  const hasImages = (id: string): boolean =>
    existsSync(path.join(ASSETS_DIR, id, "full.webp")) &&
    existsSync(path.join(ASSETS_DIR, id, "avatar.png"));

  const newCharacters = source.filter(
    (c) => !existingIds.has(c.id) || !hasImages(c.id)
  );
  const skipped = source.length - newCharacters.length;
  console.log(`新增: ${newCharacters.length} 名，跳過既有: ${skipped} 名`);

  const summary: SyncSummary = {
    existing: existing.length,
    foundFromSource: source.length,
    newCharacters: newCharacters.length,
    skipped,
    failedImages: 0,
    failedCharacters: [],
  };

  if (newCharacters.length === 0) {
    printSummary(summary);
    console.log("沒有新角色，完成。");
    return;
  }

  // 3. 分批查立繪 URL
  console.log(`查詢立繪 URL（每批 ${PORTRAIT_BATCH_SIZE}）...`);
  const portraitUrls = await fetchPortraitUrls(
    newCharacters.map((c) => c.id)
  );
  console.log(`取得立繪 URL: ${portraitUrls.size} 個`);

  // 4. 下載圖片
  // 缺立繪 URL 的角色提前紀錄（不中斷，讓有 URL 的角色繼續下載）
  const missingPortrait = newCharacters.filter((c) => !portraitUrls.has(c.id));
  for (const c of missingPortrait) {
    summary.failedCharacters.push(`${c.id} (缺少立繪 URL)`);
  }

  const downloadItems = newCharacters
    .filter((c) => portraitUrls.has(c.id))
    .map((c) => ({
      id: c.id,
      full: portraitUrls.get(c.id)!,
      avatar: deriveAvatarOriginalUrl(c.avatarThumbUrl),
      outputDir: path.join(ASSETS_DIR, c.id),
    }));

  console.log(`下載圖片 (${downloadItems.length} 名角色)...`);
  const dl = await downloadImages(downloadItems);
  summary.failedImages = Object.keys(dl.failed).length;
  // 合併：下載失敗 + 缺 portrait URL（不覆蓋前面加入的 missingPortrait）
  for (const id of Object.keys(dl.failed)) {
    summary.failedCharacters.push(`${id} (圖片下載失敗: ${dl.failed[id]})`);
  }

  // 5. 寫入成功下載的角色（全新角色 append；既有但缺圖片的角色更新）
  const existingById = new Map(existing.map((c) => [c.id, c]));
  const maxReleaseOrder = existing.reduce(
    (max, c) => Math.max(max, c.releaseOrder ?? 0),
    0
  );
  let nextOrder = maxReleaseOrder + 1;

  const updated = [...existing];
  const appended: Character[] = [];
  let filledCount = 0;

  for (const c of newCharacters) {
    if (!dl.succeeded.includes(c.id)) continue;

    const entry: Character = {
      id: c.id,
      name: c.name,
      releaseOrder: nextOrder++,
      enabled: true,
      images: {
        full: `/assets/characters/${c.id}/full.webp`,
        avatar: `/assets/characters/${c.id}/avatar.png`,
      },
      source: {
        pageUrl: c.pageUrl,
        imageUrl: portraitUrls.get(c.id),
      },
    };

    const existingEntry = existingById.get(c.id);
    if (existingEntry) {
      // 保留既有所有人工調整欄位（names、avatarPosition、rarity 等），只更新 sync 負責的部分
      updated[updated.indexOf(existingEntry)] = {
        ...existingEntry,
        name: c.name,
        images: {
          full: `/assets/characters/${c.id}/full.webp`,
          avatar: `/assets/characters/${c.id}/avatar.png`,
        },
        source: {
          pageUrl: c.pageUrl,
          imageUrl: portraitUrls.get(c.id),
        },
      };
      filledCount++;
    } else {
      appended.push(entry);
    }
  }

  if (appended.length > 0 || filledCount > 0) {
    saveAll(updated);
    summary.newCharacters = appended.length;
    console.log(
      `已寫入 ${appended.length} 名新角色、補齊 ${filledCount} 名既有角色圖片`
    );
  }

  printSummary(summary);
}

main().catch((err) => {
  console.error("同步失敗:", err);
  process.exit(1);
});
