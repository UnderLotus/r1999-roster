/**
 * sync:fandom — 半自動 skin 實裝狀態同步（海外服視角）。
 *
 * 來源：Fandom Garments 頁（reverse1999.fandom.com）＝「海外服已上架皮膚」
 * 的社群白名單。搭配 skin-unreleased.json 手動校正，輸出每個 skin 的
 * isReleased（海外服）狀態。
 *
 * 流程：
 * 1. 抓 Garments 頁 wikitext，解析所有 GarmentBox（角色英文名 + 皮膚英文名）
 * 2. 與 characters.json 的 skin（type=skin）比對：
 *    - 角色本身未實裝（isReleased=false）⇒ 該角色全部 skin 跳過（角色層未來視已過濾，不需 skin 層重複標記）
 *    - 角色已實裝且 skin 命中 Fandom 白名單（含 skin-aliases.json 譯名對照）
 *      ⇒ 判定已實裝（缺省欄位）
 *    - 角色已實裝但 skin 不在白名單 ⇒ 候選未實裝（auto-fandom，待人工確認）
 * 3. skin-unreleased.json 為校正檔：source=manual 優先於自動判定
 * 4. 寫回 characters.json：skin.isReleased（未實裝寫 false；已實裝缺省欄位）
 *
 * 顯示：結尾列出「未實裝 skin 全覽（含來源）」，方便比對誤判。
 *
 * 執行：npm run sync:fandom
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const UNRELEASED_FILE = path.join(__dirname, "data/skin-unreleased.json");
const ALIASES_FILE = path.join(__dirname, "data/skin-aliases.json");

const FANDOM_API = "https://reverse1999.fandom.com/api.php";

interface GarmentBox {
  char: string;
  skin: string;
}

interface SkinStatusEntry {
  variantId: string;
  name: string;
  nameEng: string | null;
  source: "auto-fandom" | "manual";
  isReleased: boolean;
  note: string;
}

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function fetchText(url: string): string {
  return execFileSync("curl", ["-fsSL", "-m", "60", url], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** 名稱正規化：小寫、去標點、去介詞冠詞、排序 = 容忍翻譯差異 */
const STOP = new Set([
  "the", "a", "an", "of", "in", "on", "at", "to", "from", "and",
  "for", "with", "by", "over", "under", "into", "behind", "through",
  "across", "around", "against", "as", "is", "are", "me", "my",
]);
function normName(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/'s\b/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((w) => w.length > 0 && !STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)].sort().join(" ");
}

function fetchFandomGarments(): GarmentBox[] {
  const url =
    FANDOM_API + "?action=parse&page=Garments&prop=wikitext&format=json";
  const json = JSON.parse(fetchText(url)) as {
    parse?: { wikitext?: { "*"?: string } };
  };
  const wt = json.parse?.wikitext?.["*"] ?? "";
  const boxes: GarmentBox[] = [];
  const re = /\{\{GarmentBox\|([^|}]+)\|([^|}]+)\|(\d+)\|(\d+)\|([^}|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wt)) !== null) {
    boxes.push({ char: m[1].trim(), skin: m[2].trim() });
  }
  return boxes;
}

function main(): void {
  console.log("sync:fandom — Garments 白名單同步\n");

  const characters = loadJSON<Character[]>(DATA_FILE);

  // Fandom 角色名（英文）→ 本地角色
  const charByEn = new Map<string, Character>();
  for (const c of characters) {
    const en = c.names?.["en-US"];
    if (en) charByEn.set(en.toLowerCase(), c);
    charByEn.set(c.name.toLowerCase(), c);
  }
  const charKeyFor = (c: Character): string =>
    (c.names?.["en-US"] ?? c.name).toLowerCase();
  const findCharByKey = (key: string): Character | undefined => {
    const exact = charByEn.get(key);
    if (exact) return exact;
    for (const [en, c] of charByEn) {
      if (en.length > 3 && (en.includes(key) || key.includes(en))) return c;
    }
    return undefined;
  };

  // Fandom 皮膚名 → 正規化集合
  const fandomSkinNorms = new Map<string, Set<string>>(); // charEn(lower) → skinNorms

  console.log("→ 抓取 Fandom Garments 頁...");
  let garments: GarmentBox[];
  try {
    garments = fetchFandomGarments();
  } catch (err) {
    console.error(`✗ 抓取失敗：${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
  if (garments.length < 50) {
    console.error(`✗ 解析異常：僅 ${garments.length} 件，中止`);
    process.exit(1);
  }
  console.log(`  GarmentBox: ${garments.length} 件`);

  for (const g of garments) {
    const key = g.char.toLowerCase();
    // 統一用「本地角色 key」當 Fandom 集合的 key（Fandom 短名 → 本地名）
    const local = findCharByKey(key);
    const bucketKey = local ? charKeyFor(local) : key;
    if (!fandomSkinNorms.has(bucketKey)) fandomSkinNorms.set(bucketKey, new Set());
    fandomSkinNorms.get(bucketKey)!.add(normName(g.skin));
  }

  // 譯名對照表：variantId → Fandom 皮膚名（本地英名與 Fandom 不同）
  const aliases: Record<string, string> = existsSync(ALIASES_FILE)
    ? loadJSON<Record<string, string>>(ALIASES_FILE)
    : {};
  console.log(`  Aliases: ${Object.keys(aliases).length} 組譯名對照`);

  // 預先解析 alias（限縮到「變體所屬角色」自己的 bucket，避免跨角色誤判）
  // alias 表：variantId → Fandom 皮膚名；先建「variantId → 本地角色 key」
  const variantToCharKey = new Map<string, string>();
  for (const c of characters) {
    const key = charKeyFor(c);
    for (const s of c.skins) variantToCharKey.set(s.variantId, key);
  }
  const aliasHits = new Map<string, boolean>();
  const aliasChecked = new Set<string>();
  for (const [variantId, aliasName] of Object.entries(aliases)) {
    const n = normName(aliasName);
    if (aliasChecked.has(n)) {
      aliasHits.set(variantId, aliasHits.get(variantId) ?? false);
      continue;
    }
    // 只查該變體所屬角色的 bucket（防跨角色同名前誤判）
    const ownKey = variantToCharKey.get(variantId);
    const found = ownKey ? (fandomSkinNorms.get(ownKey)?.has(n) ?? false) : false;
    aliasHits.set(variantId, found);
    aliasChecked.add(n);
  }

  // 載入校正檔（manual 優先）
  const manualEntries: SkinStatusEntry[] = (
    existsSync(UNRELEASED_FILE)
      ? loadJSON<SkinStatusEntry[]>(UNRELEASED_FILE)
      : []
  ).filter((e) => e.source === "manual");
  const manualByVariant = new Map(manualEntries.map((e) => [e.variantId, e]));

  // 逐一 skin 判定
  const autoEntries: SkinStatusEntry[] = [];
  let skinTotal = 0;
  let skinReleased = 0;
  let skinManual = 0;

  for (const c of characters) {
    for (const s of c.skins) {
      if (s.type !== "skin") continue;
      skinTotal++;
      const nameEng = s.skinNameEng ?? s.skinName ?? "";

      const manual = manualByVariant.get(s.variantId);
      if (manual) {
        skinManual++;
        if (manual.isReleased) skinReleased++;
        continue;
      }

      // 角色未實裝 ⇒ 跳過：角色層未來視已標記，skin 不需重複列
      if (!c.isReleased) continue;

      // 已實裝角色：查 Fandom 白名單（同角色名下比對）
      const norm = normName(nameEng);
      const charKey = charKeyFor(c);
      const fandomNorms = fandomSkinNorms.get(charKey);

      const aliasHit = aliasHits.get(s.variantId) ?? false;
      const hit = aliasHit || (fandomNorms ? fandomNorms.has(norm) : false);

      if (hit) {
        skinReleased++;
      } else {
        autoEntries.push({
          variantId: s.variantId,
          name: s.skinName ?? "",
          nameEng,
          source: "auto-fandom",
          isReleased: false,
          note: `Fandom 白名單未收錄（${c.name}）— 待確認`,
        });
      }
    }
  }

  // 合併寫檔：manual 優先覆蓋、auto 補齊 → 全量未實裝清單
  const merged = new Map<string, SkinStatusEntry>();
  for (const e of [...autoEntries, ...manualEntries]) {
    merged.set(e.variantId, e);
  }
  const finalList = [...merged.values()].sort((a, b) =>
    a.variantId.localeCompare(b.variantId)
  );
  writeFileSync(
    UNRELEASED_FILE,
    JSON.stringify(finalList, null, 2) + "\n",
    "utf-8"
  );

  // 寫回 characters.json：skin.isReleased 只在有判定時寫入
  //   （已實裝的 skin 不寫 true —— 缺省即視為已實裝，最小化 diff）
  for (const c of characters) {
    for (const s of c.skins) {
      if (s.type !== "skin") continue;
      const entry = merged.get(s.variantId);
      if (entry) s.isReleased = entry.isReleased;
      else delete s.isReleased;
    }
  }
  writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2) + "\n", "utf-8");

  const unreleased = finalList.filter((e) => !e.isReleased);
  console.log(`\n=== 摘要 ===`);
  console.log(`Skin 總數: ${skinTotal}`);
  console.log(
    `判定已實裝（海外，缺省即已實裝）: ${skinReleased}，手動修正: ${skinManual}`
  );
  console.log(
    `未實裝清單: ${unreleased.length} 筆（已實裝不寫 true 欄位，缺省即已實裝）`
  );
  if (unreleased.length > 0) {
    console.log(`\n=== 未實裝 skin 全覽（${unreleased.length}）===`);
    for (const e of unreleased) {
      console.log(
        `  [${e.source}] ${e.variantId} ${e.name} (${e.nameEng ?? "?"}) — ${e.note}`
      );
    }
  }
}

main();