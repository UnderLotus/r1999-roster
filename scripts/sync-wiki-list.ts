/**
 * 灰機 Wiki 角色列表即時同步（全自動排序來源）。
 *
 * 1. 以 curl_cffi（chrome124 impersonation）抓取灰機「角色列表」頁，
 *    取得全部角色的「顯示順序 + 頁面網址」（fetch-huiji-list.py）
 * 2. 對 characters.json 中出現於列表的角色：
 *    - 寫入 source.pageUrl（wiki 正式網址，冪等）
 *    - 標記臨時欄位 _wikiIndex（列表中的順序）
 * 3. recalculateReleaseOrder() 以 _wikiIndex 重排（灰機線 = 即時列表序）
 * 4. 清理臨時欄位並寫回
 *
 * 不在列表中的角色不處理：有 pageUrl 者留在 wiki 線（既有順序排尾），
 * 無 pageUrl 者依 tier2/3 規則，累計並警告。
 * 抓取失敗 → 直接失敗退出，不改寫任何檔案。
 *
 * 先決條件：.venv/bin/python + curl_cffi（見 maintenance.md）。
 *
 * 執行：npm run sync:wiki
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character } from "./types";
import { recalculateReleaseOrder } from "./recalculate-order";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const PYTHON = path.join(ROOT, ".venv", "bin", "python");
const HELPER = path.join(__dirname, "fetch-huiji-list.py");

interface WikiCard {
  id: number; // variant ID（headicon 檔名，例 314901）
  name: string;
  href: string;
}

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

async function main(): Promise<void> {
  console.log("灰機列表同步\n");

  if (!existsSync(PYTHON)) {
    console.error(
      `✗ 找不到 ${PYTHON}\n` +
        "  請先建立 venv 並安裝 curl_cffi（.venv/bin/pip install curl_cffi），" +
        "詳見 maintenance.md"
    );
    process.exit(1);
  }
  if (!existsSync(DATA_FILE)) {
    console.error(`✗ ${DATA_FILE} 不存在`);
    process.exit(1);
  }

  // 1. 抓取灰機列表（transient Cloudflare 403 時重試一次）
  console.log("→ 抓取灰機角色列表（curl_cffi chrome124 impersonation）...");
  let cards: WikiCard[] | undefined;
  let fetchError: string | null = null;
  for (let attempt = 1; attempt <= 2 && cards === undefined; attempt++) {
    try {
      const raw = execFileSync(PYTHON, [HELPER], {
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
      });
      cards = JSON.parse(raw) as WikiCard[];
      break;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      fetchError = detail;
      if (attempt === 1) {
        console.warn(`⚠ 第 ${attempt} 次抓取失敗（${detail}），3 秒後重試...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  if (!cards) {
    console.error(
      `✗ 抓取失敗：${fetchError}\n  資料未變更，可直接重跑。`
    );
    process.exit(1);
  }
  if (cards.length < 100) {
    console.error(`✗ 解析異常：僅 ${cards.length} 張卡，中止。`);
    process.exit(1);
  }
  console.log(`  列表共 ${cards.length} 名角色`);

  // baseId → 列表順序 / 卡片
  const indexByBaseId = new Map<number, number>();
  for (let i = 0; i < cards.length; i++) {
    indexByBaseId.set(Math.floor(cards[i].id / 100), i);
  }

  // 2. 對應 characters.json（寫 pageUrl + 標記 _wikiIndex）
  const characters = loadJSON<Character[]>(DATA_FILE);
  let indexed = 0;
  let pageUrlUpdated = 0;
  let pageUrlKept = 0;
  const notInWiki: string[] = [];

  for (const ch of characters) {
    const idx = indexByBaseId.get(ch.baseId);
    if (idx === undefined) {
      notInWiki.push(ch.id);
      continue;
    }
    const href = cards[idx].href;
    ch._wikiIndex = idx;
    indexed++;
    if (ch.source?.pageUrl !== href) {
      ch.source = { pageUrl: href, ...ch.source };
      pageUrlUpdated++;
    } else {
      pageUrlKept++;
    }
  }
  if (notInWiki.length > 0) {
    console.warn(
      `⚠ ${notInWiki.length} 名不在灰機列表中` +
        `（有 pageUrl 者保留既有順序排於 wiki 線後段）：` +
        notInWiki.join("、")
    );
  }

  // 3. 以 _wikiIndex 重算 releaseOrder
  const before = new Map(characters.map((c) => [c.id, c.releaseOrder]));
  const ordered = recalculateReleaseOrder(characters);
  let moved = 0;
  for (const c of ordered) {
    if (before.get(c.id) !== c.releaseOrder) moved++;
  }

  // 4. 清理臨時欄位 + 寫回
  for (const c of ordered) {
    delete c._kbId;
    delete c._wikiIndex;
  }
  writeFileSync(DATA_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf-8");

  console.log(`\n=== 摘要 ===`);
  console.log(`已索引: ${indexed}/${characters.length}`);
  console.log(`pageUrl 更新: ${pageUrlUpdated}，維持不變: ${pageUrlKept}`);
  console.log(`排序變動: ${moved} 名（以灰機即時列表序為準）`);
}

main().catch((err) => {
  console.error("sync:wiki failed:", err);
  process.exit(1);
});