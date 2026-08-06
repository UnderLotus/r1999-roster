/**
 * 多語系角色名稱對照腳本。
 *
 * 來源：
 *   - Kornblume（windbow27/kornblume）：lang/static/arcanists/{lang}.json（5 語系）
 *     + public/data/arcanists.json（132 名角色，依釋出順序）
 *   - wikiru（日文攻略 wiki）：補 Kornblume ja-JP 缺的最新角色日文名
 *   - Fandom：補 ko-KR（name_kor 欄位）
 *
 * 流程：下載來源 → 合併語系名 → 依順序對應角色 → 產生 characters.json 的 names。
 * 來源為權威資料，直接覆寫 names（人工修正應改來源或資料本身）。
 *
 * 執行：npm run build:names
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character } from "../src/types/character";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const JP_OVERRIDES_FILE = path.join(__dirname, "data/jp-name-overrides.json");

const LANGS = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
type Lang = (typeof LANGS)[number];

const BASE =
  "https://raw.githubusercontent.com/windbow27/kornblume/main";
const WIKIRU_JP_URL =
  "https://r.jina.ai/https://reverse1999.wikiru.jp/?%E3%82%AD%E3%83%A3%E3%83%A9%E3%82%AF%E3%82%BF%E3%83%BC%E4%B8%80%E8%A6%A7%28%E3%83%95%E3%82%A3%E3%83%AB%E3%82%BF%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB%E7%89%88%29";

interface KornblumeArcanist {
  Id: number;
  Name: string;
}

function fetchText(url: string): string {
  return execFileSync("curl", ["-fsSL", "-m", "60", url], {
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** 英文名 → kebab-case（純數字保留；非 ASCII 字元保留） */
function slugify(name: string): string {
  const lower = name.toLowerCase().trim();
  if (/^\d+$/.test(lower)) return lower;
  return lower.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

interface WikiRuResult {
  map: Record<string, string>;
  unmatched: string[];
}

/**
 * 從 wikiru 篩選表格版解析日文名。
 * 角色行：`[![Image N](...attach2/HEX.png) 日文名](...)`
 * HEX 解碼後為 `img{名稱}_icon.png`，名稱可能是英文或日文。
 *
 * 對應通則：
 * - 英文 icon → 以 slug 直接對應
 * - 日文 icon → 反查 Kornblume ja-JP → 查 JP_NAME_OVERRIDES
 * - 都對不到時收集進 unmatched（不中斷，由 caller 決定如何處理）
 */
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

  interface Row {
    iconName: string;
    jpName: string;
  }
  const rows: Row[] = [];
  let idx = 0;
  while (true) {
    const start = markdown.indexOf("attach2/", idx);
    if (start < 0) break;
    idx = start + 8;

    let hex = "";
    let p = idx;
    while (p < markdown.length && /[0-9a-fA-F_]/.test(markdown[p])) {
      hex += markdown[p];
      p++;
    }
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
    try {
      decoded = Buffer.from(cleanHex, "hex").toString("utf-8");
    } catch {
      continue;
    }
    if (decoded.includes("\uFFFD")) continue;

    const iconMarker = "img";
    const iconEnd = decoded.indexOf("_icon");
    if (!decoded.startsWith(iconMarker) || iconEnd < 0) continue;
    const iconName = decoded.slice(iconMarker.length, iconEnd).trim();
    if (!iconName) continue;

    rows.push({ iconName, jpName });
  }

  for (const row of rows) {
    const isLatin = /^[\p{Script=Latin}\p{N} .,'\-]+$/u.test(row.iconName);
    if (isLatin) {
      map[slugify(row.iconName)] = row.jpName;
      continue;
    }

    // 日文 icon：先反查 Kornblume
    const slug = jpNameToSlug.get(row.jpName);
    if (slug) {
      map[slug] = row.jpName;
      continue;
    }

    // 反查失敗：用 override 清單
    const knownEn = jpOverrides[row.jpName];
    if (knownEn) {
      map[slugify(knownEn)] = row.jpName;
      continue;
    }

    unmatched.push(row.jpName);
  }

  return { map, unmatched };
}

/** 從 Fandom 角色頁抓 name_kor，補齊 ko-KR（並行抓取） */
async function fetchFandomKrMap(
  arcanists: KornblumeArcanist[]
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const CONCURRENCY = 8;
  let fetchFailures = 0;

  const fetchOne = async (
    enName: string
  ): Promise<[string, string] | null> => {
    const page = encodeURIComponent(enName.replace(/ /g, "_"));
    try {
      const res = await fetch(
        `https://reverse1999.fandom.com/api.php?action=parse&page=${page}&format=json&prop=wikitext&origin=*`,
        { signal: AbortSignal.timeout(15000) }
      );
      if (!res.ok) {
        fetchFailures++; // 網路/HTTP 錯誤（rate limit、改版）
        return null;
      }
      const data = (await res.json()) as {
        parse?: { wikitext?: { "*"?: string } };
      };
      const wikitext = data.parse?.wikitext?.["*"] ?? "";

      // 找 name_kor= 的值（簡單字串操作）
      const marker = "name_kor=";
      const markerIdx = wikitext.indexOf(marker);
      if (markerIdx < 0) return null; // 缺 name_kor 是正常（韓服未實裝）
      let kr = wikitext.slice(markerIdx + marker.length).trim();
      const end = kr.search(/[\n|]/);
      if (end >= 0) kr = kr.slice(0, end).trim();
      // 過濾 template 殘留（{{ }} [[ ]] 等）
      if (!kr || /[{}[\]]/.test(kr)) return null;
      return [enName, kr];
    } catch {
      fetchFailures++;
      return null;
    }
  };

  const queue = arcanists.map((a) => a.Name);
  for (let i = 0; i < queue.length; i += CONCURRENCY) {
    const batch = queue.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(fetchOne));
    for (const r of results) {
      if (r) map[r[0]] = r[1];
    }
  }

  // 品質門檻：失敗過多代表來源異常（rate limit/改版），不應靜默成功
  if (fetchFailures > 10) {
    throw new Error(`Fandom 抓取失敗 ${fetchFailures} 名，來源可能異常`);
  }

  return map;
}

async function main(): Promise<void> {
  console.log("下載 Kornblume 多語系資料...");

  // 0. 載入日文名 override 清單（Kornblume 尚未收錄的新角）
  const jpOverrides: Record<string, string> = {};
  const overrideList = JSON.parse(
    readFileSync(JP_OVERRIDES_FILE, "utf-8")
  ) as { jpName: string; enName: string }[];
  for (const { jpName, enName } of overrideList) {
    jpOverrides[jpName] = enName;
  }
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

  // 2. wikiru 補 ja-JP（重試一次，防 Jina 不完整回傳）
  let wikiruResult = fetchWikiRuJaMap(namesByLang["ja-JP"], jpOverrides);
  if (Object.keys(wikiruResult.map).length < 30) {
    console.warn(
      `wikiru 首次解析僅 ${Object.keys(wikiruResult.map).length} 名，重試...`
    );
    wikiruResult = fetchWikiRuJaMap(namesByLang["ja-JP"], jpOverrides);
  }
  if (Object.keys(wikiruResult.map).length < 30) {
    throw new Error(
      `wikiru 解析異常：僅 ${Object.keys(wikiruResult.map).length} 名，來源格式可能變動`
    );
  }
  if (wikiruResult.unmatched.length > 0) {
    console.warn(
      `⚠ wikiru 有 ${wikiruResult.unmatched.length} 名角色無法對應：${wikiruResult.unmatched.join("、")}`
    );
  }
  let wikiruAdded = 0;
  for (const [slug, jpName] of Object.entries(wikiruResult.map)) {
    if (!namesByLang["ja-JP"][slug]) {
      namesByLang["ja-JP"][slug] = jpName;
      wikiruAdded++;
    }
  }
  console.log(`  wikiru 補齊 ja-JP: +${wikiruAdded} 名`);

  // 3. Fandom 補 ko-KR
  const fandomKr = await fetchFandomKrMap(arcanists);
  let fandomAdded = 0;
  for (const [enName, krName] of Object.entries(fandomKr)) {
    const slug = slugify(enName);
    if (!namesByLang["ko-KR"][slug]) {
      namesByLang["ko-KR"][slug] = krName;
      fandomAdded++;
    }
  }
  console.log(`  Fandom 補齊 ko-KR: +${fandomAdded} 名`);

  // 4. 讀取角色，依順序對應（Kornblume 順序 = 本專案 releaseOrder 順序）
  const characters = JSON.parse(
    readFileSync(DATA_FILE, "utf-8")
  ) as Character[];
  const sorted = [...characters].sort(
    (a, b) => a.releaseOrder - b.releaseOrder
  );

  if (sorted.length !== arcanists.length) {
    throw new Error(
      `角色數不符：characters.json ${sorted.length} vs Kornblume ${arcanists.length}`
    );
  }

  // 5. 為每個角色產生 names（來源權威，直接覆寫）
  const crossCheckMismatches: string[] = [];
  let withNames = 0;
  for (let i = 0; i < sorted.length; i++) {
    const character = sorted[i];
    const kb = arcanists[i];
    const slug = slugify(kb.Name);

    // 驗證：英文名 slug 必須存在於 en-US.json（代表來源順序正確）
    if (!(slug in namesByLang["en-US"])) {
      throw new Error(
        `slug 對照失敗 index=${i}: 專案=${character.id} ${character.name}, Kornblume=${kb.Id} ${kb.Name} (slug=${slug})`
      );
    }

    // 交叉比對：既有 names["en-US"] 與 Kornblume 英文名不一致時警告（可能次序錯位）
    const existingEn = character.names?.["en-US"];
    if (existingEn && existingEn !== kb.Name) {
      crossCheckMismatches.push(
        `${character.id} ${character.name}: 既有="${existingEn}" vs Kornblume="${kb.Name}"`
      );
    }

    const names: Partial<Record<Lang, string>> = {};
    for (const lang of LANGS) {
      const name = namesByLang[lang][slug];
      if (name) names[lang] = name;
    }

    character.names = names as Character["names"];
    if (Object.keys(names).length > 0) withNames++;
  }

  // 6. 寫回 + 摘要
  writeFileSync(DATA_FILE, JSON.stringify(characters, null, 2) + "\n", "utf-8");
  console.log(`已寫入 ${withNames}/${characters.length} 名角色的多語系名稱`);

  if (crossCheckMismatches.length > 0) {
    console.warn(
      `⚠ ${crossCheckMismatches.length} 名角色英文名與 Kornblume 不一致（可能次序錯位）：`
    );
    for (const msg of crossCheckMismatches) {
      console.warn(`  ${msg}`);
    }
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
