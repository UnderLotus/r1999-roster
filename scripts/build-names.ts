/**
 * 多語系角色名稱 + 星數同步腳本。
 *
 * 來源（優先序低 → 高）：
 *   1. CN 解包 ArcanistMap：基線 zh-CN（name）／en-US（nameEng），
 *      新角色未被上游收錄前即有顯示名
 *   2. Kornblume（windbow27/kornblume）：lang/static/arcanists/{lang}.json（5 語系）
 *      + public/data/arcanists.json（含 Rarity / Id / Name）
 *   3. wikiru（日本攻略 wiki）：補 ja-JP；Fandom：補 ko-KR（name_kor 欄位）
 *   4. Global 解包（St-Pavlov-Foundation/re1999-data-global）：權威覆蓋——角色收錄時
 *      zh-CN/zh-TW/ja-JP/ko-KR 以 GL 語言檔為準（衝突以 GL 勝出）；en-US 經三層
 *      resolver（GL > Kornblume/CN 基線 > 既有值）判定
 *
 * 對應方式：GL 以 baseId → character.id → name localization key → 各語言檔 content；
 * 其餘語系與 Kornblume metadata 以 ArcanistMap 的 nameEng → slug → Kornblume Name 橋接。
 *
 * Phase 2：寫入 rarity、_kbId；將 stage 從 pending-names 升為 live。
 * Phase 3：recalculateReleaseOrder（見 build-characters.ts 的共享函式）。
 *
 * 執行：npm run build:names
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character } from "./types";
import {
  buildGlobalEnglishNames,
  resolveEnglishName,
  type GlobalCharacterEntry,
  type GlobalLocalizationEntry,
} from "./english-name";
import { recalculateReleaseOrder } from "./recalculate-order";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");
const JP_OVERRIDES_FILE = path.join(__dirname, "data/jp-name-overrides.json");
const LOCALIZED_NAME_OVERRIDES_FILE = path.join(
  __dirname,
  "data/localized-name-overrides.json"
);

const LANGS = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
type Lang = (typeof LANGS)[number];

const BASE =
  "https://raw.githubusercontent.com/windbow27/kornblume/main";
const GLOBAL_CHARACTER_URL =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/json/character.json";
const GLOBAL_LANGUAGE_BASE =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/configs/language";
/** 各語系對應的 GL 語言檔（language_zh 已取樣確認為簡體）。 */
const GLOBAL_LANGUAGE_FILES: Record<Lang, string> = {
  "zh-CN": "language_zh.json",
  "zh-TW": "language_tw.json",
  "en-US": "language_en.json",
  "ja-JP": "language_jp.json",
  "ko-KR": "language_kr.json",
};
const WIKIRU_JP_URL =
  "https://r.jina.ai/https://reverse1999.wikiru.jp/?%E3%82%AD%E3%83%A3%E3%83%A9%E3%82%AF%E3%82%BF%E3%83%BC%E4%B8%80%E8%A6%A7%28%E3%83%95%E3%82%A3%E3%83%AB%E3%82%BF%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB%E7%89%88%29";

interface KornblumeArcanist {
  Id: number;
  Name: string;
  Rarity: number;
}

// Kept locally for the Global data shape only; display names come from language_en.json.
interface GlobalCharacter extends GlobalCharacterEntry {}

interface ArcanistMapEntry {
  id: number;
  name: string;
  nameEng: string;
}

type LocalizedNameOverride = { nameEng: string } & Partial<Record<Lang, string>>;

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function fetchText(
  url: string,
  maxBuffer = 16 * 1024 * 1024
): string {
  return execFileSync("curl", ["-fsSL", "-m", "180", "--retry", "2", url], {
    encoding: "utf-8",
    maxBuffer,
  });
}

function slugify(name: string): string {
  const lower = name.toLowerCase().trim();
  if (/^\d+$/.test(lower)) return lower;
  return lower.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

type GlobalNamesByLang = Partial<Record<Lang, Map<number, string>>>;

/** 抓取 GL 全語言檔並建立 baseId → 顯示名；單一語言檔失敗僅跳過該語系。 */
function fetchGlobalNames(): GlobalNamesByLang {
  let characters: GlobalCharacter[];
  try {
    characters = JSON.parse(fetchText(GLOBAL_CHARACTER_URL)) as GlobalCharacter[];
  } catch (error) {
    console.warn(`⚠ Global character.json 下載失敗，本輪不做 GL 名稱覆蓋：${String(error)}`);
    return {};
  }

  const result: GlobalNamesByLang = {};
  for (const lang of LANGS) {
    try {
      // 各語言檔約 18–23 MB，給予較大 buffer。
      const localizations = JSON.parse(
        fetchText(
          `${GLOBAL_LANGUAGE_BASE}/${GLOBAL_LANGUAGE_FILES[lang]}`,
          40 * 1024 * 1024
        )
      ) as GlobalLocalizationEntry[];
      // buildGlobalEnglishNames 是泛用 key→content 解析，各語言檔結構相同。
      result[lang] = buildGlobalEnglishNames(characters, localizations);
      console.log(`  Global ${lang}: ${result[lang]?.size ?? 0} 名`);
    } catch (error) {
      console.warn(
        `⚠ Global ${GLOBAL_LANGUAGE_FILES[lang]} 下載失敗，該語系維持既有來源：${String(error)}`
      );
    }
  }
  return result;
}

interface WikiRuResult {
  map: Record<string, string>;
  unmatched: string[];
}

function fetchWikiRuJaMap(
  kbJp: Record<string, string>,
  jpOverrides: Record<string, string>
): WikiRuResult {
  const markdown = fetchText(WIKIRU_JP_URL);
  const map: Record<string, string> = {};
  const unmatched: string[] = [];
  const jpNameToSlug = new Map<string, string>();
  for (const [slug, name] of Object.entries(kbJp)) {
    jpNameToSlug.set(name, slug);
  }

  interface Row { iconName: string; jpName: string }
  const rows: Row[] = [];
  let idx = 0;
  while (true) {
    const start = markdown.indexOf("attach2/", idx);
    if (start < 0) break;
    idx = start + 8;
    let hex = "";
    let p = idx;
    while (p < markdown.length && /[0-9a-fA-F_]/.test(markdown[p])) { hex += markdown[p]; p++ }
    if (!markdown.startsWith(".png)", p)) continue;
    const nameStart = p + 5;
    if (markdown[nameStart] !== " ") continue;
    const nameEnd = markdown.indexOf("](", nameStart + 1);
    if (nameEnd < 0) continue;
    const jpName = markdown.slice(nameStart + 1, nameEnd).trim();
    if (!jpName) continue;
    const cleanHex = hex.replace(/_/g, "");
    if (cleanHex.length === 0 || cleanHex.length % 2 !== 0) continue;
    let decoded: string;
    try { decoded = Buffer.from(cleanHex, "hex").toString("utf-8") } catch { continue }
    if (decoded.includes("\uFFFD")) continue;
    const iconEnd = decoded.indexOf("_icon");
    if (!decoded.startsWith("img") || iconEnd < 0) continue;
    const iconName = decoded.slice(3, iconEnd).trim();
    if (!iconName) continue;
    rows.push({ iconName, jpName });
  }

  for (const row of rows) {
    const isLatin = /^[\p{Script=Latin}\p{N} .,'\-]+$/u.test(row.iconName);
    if (isLatin) { map[slugify(row.iconName)] = row.jpName; continue }
    const slug = jpNameToSlug.get(row.jpName);
    if (slug) { map[slug] = row.jpName; continue }
    const knownEn = jpOverrides[row.jpName];
    if (knownEn) { map[slugify(knownEn)] = row.jpName; continue }
    unmatched.push(row.jpName);
  }
  return { map, unmatched };
}

async function fetchFandomKrMap(
  arcanists: KornblumeArcanist[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const CONCURRENCY = 8;
  let fetchFailures = 0;

  const fetchOne = async (enName: string): Promise<[string, string] | null> => {
    const page = encodeURIComponent(enName.replace(/ /g, "_"));
    try {
      const res = await fetch(
        `https://reverse1999.fandom.com/api.php?action=parse&page=${page}&format=json&prop=wikitext&origin=*`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) { fetchFailures++; return null }
      const data = (await res.json()) as { parse?: { wikitext?: { "*"?: string } } };
      const wikitext = data.parse?.wikitext?.["*"] ?? "";
      const marker = "name_kor=";
      const markerIdx = wikitext.indexOf(marker);
      if (markerIdx < 0) return null;
      let kr = wikitext.slice(markerIdx + marker.length).trim();
      const end = kr.search(/[\n|]/);
      if (end >= 0) kr = kr.slice(0, end).trim();
      if (!kr || /[{}[\]]/.test(kr)) return null;
      return [enName, kr];
    } catch { fetchFailures++; return null }
  };

  const queue = arcanists.map((a) => a.Name);
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchOne));
    for (const r of results) { if (r) map[r[0]] = r[1] }
  }

  if (fetchFailures > 10) {
    throw new Error(`Fandom 抓取失敗 ${fetchFailures} 名，來源可能異常`);
  }
  return map;
}

/**
 * CN 基線：Kornblume／GL 尚未收錄的角色（CN 新角）以 ArcanistMap 寫入
 * zh-CN（name）與 en-US（nameEng）；已有值不覆蓋，待上游收錄後自然升級。
 */
function applyArcanistBaseline(character: Character, entry: ArcanistMapEntry): void {
  character.names ??= {};
  if (!character.names["zh-CN"]) character.names["zh-CN"] = entry.name;
  if (!character.names["en-US"]) character.names["en-US"] = entry.nameEng;
}

async function main(): Promise<void> {
  console.log("下載 Kornblume 多語系資料...");

  // 0. 載入日文名 override 清單
  const jpOverrides: Record<string, string> = {};
  const overrideList = JSON.parse(
    readFileSync(JP_OVERRIDES_FILE, "utf-8")
  ) as { jpName: string; enName: string }[];
  for (const { jpName, enName } of overrideList) jpOverrides[jpName] = enName;
  console.log(`  日文名 override: ${overrideList.length} 筆`);

  // 1. 下載 5 語系角色名 + arcanists.json
  const namesByLang: Record<Lang, Record<string, string>> = {} as never;
  for (const lang of LANGS) {
    const url = `${BASE}/lang/static/arcanists/${lang}.json`;
    namesByLang[lang] = JSON.parse(fetchText(url)) as Record<string, string>;
    console.log(`  ${lang}: ${Object.keys(namesByLang[lang]).length} 名`);
  }

  const arcanists = JSON.parse(
    fetchText(`${BASE}/public/data/arcanists.json`)
  ) as KornblumeArcanist[];
  console.log(`  arcanists.json: ${arcanists.length} 名`);

  // Global 英文名獨立抓取；失敗時保留現有 Kornblume／既有值 fallback。
  const globalNames = fetchGlobalNames();

  // 2. wikiru 補 ja-JP
  let wikiruResult = fetchWikiRuJaMap(namesByLang["ja-JP"], jpOverrides);
  if (Object.keys(wikiruResult.map).length < 30) {
    console.warn(`wikiru 首次解析僅 ${Object.keys(wikiruResult.map).length} 名，重試...`);
    wikiruResult = fetchWikiRuJaMap(namesByLang["ja-JP"], jpOverrides);
  }
  if (Object.keys(wikiruResult.map).length < 30) {
    throw new Error(`wikiru 解析異常：僅 ${Object.keys(wikiruResult.map).length} 名`);
  }
  if (wikiruResult.unmatched.length > 0) {
    console.warn(
      `⚠ wikiru 有 ${wikiruResult.unmatched.length} 名角色無法對應：${wikiruResult.unmatched.join("、")}`
    );
  }
  let wikiruAdded = 0;
  for (const [slug, jpName] of Object.entries(wikiruResult.map)) {
    if (!namesByLang["ja-JP"][slug]) { namesByLang["ja-JP"][slug] = jpName; wikiruAdded++ }
  }
  console.log(`  wikiru 補齊 ja-JP: +${wikiruAdded} 名`);

  // 3. Fandom 補 ko-KR
  const fandomKr = await fetchFandomKrMap(arcanists);
  let fandomAdded = 0;
  for (const [enName, krName] of Object.entries(fandomKr)) {
    const slug = slugify(enName);
    if (!namesByLang["ko-KR"][slug]) { namesByLang["ko-KR"][slug] = krName; fandomAdded++ }
  }
  console.log(`  Fandom 補齊 ko-KR: +${fandomAdded} 名`);

  // 4. Build Kornblume slug → arcanist lookup
  const kbBySlug = new Map<string, KornblumeArcanist>();
  for (const kb of arcanists) {
    kbBySlug.set(slugify(kb.Name), kb);
  }

  // 5. Build cnName → slug lookup from Kornblume zh-CN data
  //    ArcanistMap's zh-CN name → Kornblume zh-CN slug → Kornblume en Name slug → Rarity
  const cnToSlug = new Map<string, string>();
  for (const [slug, name] of Object.entries(namesByLang["zh-CN"])) {
    cnToSlug.set(name, slug);
  }

  // 6. Load ArcanistMap for zh-CN bridge + CN baseline fallback
  const arcanistMap = loadJSON<ArcanistMapEntry[]>(ARCANIST_MAP);
  const arcanistByBase = new Map<number, ArcanistMapEntry>();
  for (const a of arcanistMap) {
    arcanistByBase.set(a.id, a);
  }

  // 7. Match characters.json entries to Kornblume via zh-CN name bridge
  const characters = loadJSON<Character[]>(DATA_FILE);
  const existingEnglishNames = new Map(
    characters.map((character) => [character.id, character.names?.["en-US"]])
  );
  let nameApplied = 0;
  let rarityApplied = 0;
  const unmatched: string[] = [];

  for (const character of characters) {
    const mapEntry = arcanistByBase.get(character.baseId);
    if (!mapEntry) {
      unmatched.push(`${character.id} ${character.name}: baseId not in ArcanistMap`);
      continue;
    }
    const slug = cnToSlug.get(mapEntry.name);
    if (!slug) {
      applyArcanistBaseline(character, mapEntry);
      unmatched.push(`${character.id} ${character.name}: cnName "${mapEntry.name}" not in Kornblume`);
      continue;
    }
    const kb = kbBySlug.get(slug);
    if (!kb) {
      applyArcanistBaseline(character, mapEntry);
      unmatched.push(`${character.id} ${character.name}: slug "${slug}" not in Kornblume arcanists`);
      continue;
    }

    const existingEnglishName = character.names?.["en-US"];
    const names: Partial<Record<Lang, string>> = {};
    for (const lang of LANGS) {
      const name = namesByLang[lang][slug];
      if (name) names[lang] = name;
    }
    if (!names["en-US"] && existingEnglishName) {
      names["en-US"] = existingEnglishName;
    }
    if (Object.keys(names).length > 0) {
      character.names = names;
      nameApplied++;
    }

    if (kb.Rarity) {
      character.rarity = kb.Rarity;
      character._kbId = kb.Id;
      rarityApplied++;
    }

    if (character.stage === "pending-names") {
      character.stage = "live";
    }
  }

  // 6.5. 套用人工確認的本地化名稱（來源延遲或自動對應失敗時使用）
  const localizedOverrides = loadJSON<LocalizedNameOverride[]>(
    LOCALIZED_NAME_OVERRIDES_FILE
  );
  const characterByEnglishName = new Map(
    characters.map((c) => [c.names?.["en-US"] ?? c.name, c])
  );
  let localizedOverridesApplied = 0;
  const unmatchedLocalizedOverrides: string[] = [];
  for (const override of localizedOverrides) {
    const character = characterByEnglishName.get(override.nameEng);
    if (!character) {
      unmatchedLocalizedOverrides.push(override.nameEng);
      continue;
    }
    character.names ??= {};
    for (const lang of LANGS) {
      const name = override[lang];
      if (!name) continue;
      character.names[lang] = name;
      localizedOverridesApplied++;
    }
  }
  console.log(
    `  localized name overrides: ${localizedOverridesApplied} 個欄位／${localizedOverrides.length} 名`
  );
  if (unmatchedLocalizedOverrides.length > 0) {
    console.warn(
      `⚠ localized name overrides 無法對應：${unmatchedLocalizedOverrides.join("、")}`
    );
  }

  // 6.6. GL 解包權威覆蓋（zh-CN / zh-TW / ja-JP / ko-KR）：角色收錄即以 GL 為準，
  //      與既有值衝突時 GL 勝出。en-US 另由下方三層 resolver 判定。
  let glFieldsApplied = 0;
  let glCharacters = 0;
  for (const character of characters) {
    let covered = false;
    for (const lang of LANGS) {
      if (lang === "en-US") continue;
      const name = globalNames[lang]?.get(character.baseId);
      if (!name) continue;
      covered = true;
      character.names ??= {};
      if (character.names[lang] !== name) glFieldsApplied++;
      character.names[lang] = name;
    }
    if (covered) glCharacters++;
  }
  console.log(
    `  GL 全語系覆蓋: ${glCharacters}/${characters.length} 名，更新 ${glFieldsApplied} 欄位`
  );

  // 6.7. en-US 三層解析：Global > 本輪結果（含 CN 基線）> 既有值；缺值時不清空。
  let globalEnglishApplied = 0;
  let englishFallback = 0;
  let englishMissing = 0;
  for (const character of characters) {
    const resolution = resolveEnglishName(
      globalNames["en-US"] ?? new Map<number, string>(),
      character.baseId,
      character.names?.["en-US"],
      existingEnglishNames.get(character.id)
    );
    if (resolution.name) {
      character.names ??= {};
      character.names["en-US"] = resolution.name;
    }
    if (resolution.source === "global") {
      globalEnglishApplied++;
    } else if (resolution.source === "fallback" || resolution.source === "existing") {
      englishFallback++;
    } else {
      englishMissing++;
    }
  }
  console.log(
    `  en-US 解析: global ${globalEnglishApplied}/${characters.length} 名；` +
      `fallback/existing: ${englishFallback} 名；缺名: ${englishMissing} 名`
  );

  // 7. Recalculate releaseOrder based on multi-source rules
  //    (needs _kbId on Kornblume-group characters)
  const ordered = recalculateReleaseOrder(characters);
  console.log(`  排序重算完成（Wiki: ${ordered.filter(c => c.source?.pageUrl).length}, Kornblume: ${ordered.filter(c => !c.source?.pageUrl && c.rarity !== undefined).length}, CN-only: ${ordered.filter(c => !c.source?.pageUrl && c.rarity === undefined).length}）`);

  // 8. Clean temporary fields + write back
  for (const character of ordered) {
    delete character._kbId;
  }
  writeFileSync(DATA_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf-8");

  console.log(`\n=== 摘要 ===`);
  console.log(`名稱: ${nameApplied}/${ordered.length}`);
  console.log(`星數: ${rarityApplied}/${ordered.length}`);
  if (unmatched.length > 0) {
    console.warn(`⚠ 無法匹配 ${unmatched.length} 名角色：`);
    for (const u of unmatched.slice(0, 10)) console.warn(`  ${u}`);
    if (unmatched.length > 10) console.warn(`  ... +${unmatched.length - 10} 名`);
  }

  const missing: Record<string, number> = {};
  for (const lang of LANGS) {
    missing[lang] = characters.filter((c) => !c.names?.[lang]).length;
  }
  console.log("缺名統計:", JSON.stringify(missing));
}

main().catch((err) => {
  console.error("失敗:", err);
  process.exit(1);
});
