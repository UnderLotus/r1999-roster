import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

import {
  installNameSourceCache,
  NAME_SOURCE_CACHE_FILE,
} from "./name-source-cache";
import {
  createNameSourceSnapshot,
  NAME_LANGS,
  NameConfigurationError,
  NameSourceError,
  normalizeFandomKoreanSource,
  parseGlobalSource,
  parseKornblumeSource,
  parseWikiRuJapaneseSource,
  type NameLang,
  type NameSourceSnapshot,
} from "./name-source";

const KORNBLUME_BASE =
  "https://raw.githubusercontent.com/windbow27/kornblume/main";
const GLOBAL_CHARACTER_URL =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/json/character.json";
const GLOBAL_LANGUAGE_BASE =
  "https://raw.githubusercontent.com/St-Pavlov-Foundation/re1999-data-global/main/data/configs/language";
const GLOBAL_LANGUAGE_FILES: Record<NameLang, string> = {
  "zh-CN": "language_zh.json",
  "zh-TW": "language_tw.json",
  "en-US": "language_en.json",
  "ja-JP": "language_jp.json",
  "ko-KR": "language_kr.json",
};
const WIKIRU_JP_URL =
  "https://r.jina.ai/https://reverse1999.wikiru.jp/?%E3%82%AD%E3%83%A3%E3%83%A9%E3%82%AF%E3%82%BF%E3%83%BC%E4%B8%80%E8%A6%A7%28%E3%83%95%E3%82%A3%E3%83%AB%E3%82%BF%E3%83%86%E3%83%BC%E3%83%96%E3%83%AB%E7%89%88%29";

function fetchText(url: string, maxBuffer = 16 * 1024 * 1024): string {
  try {
    return execFileSync("curl", ["-fsSL", "-m", "180", "--retry", "2", url], {
      encoding: "utf8",
      maxBuffer,
    });
  } catch (error) {
    throw new NameSourceError("transport", url, `failed to fetch ${url}`, {
      cause: error,
    });
  }
}

async function fetchFandomRows(
  englishNames: readonly string[]
): Promise<{
  rows: Array<{ englishName: string; wikitext: string }>;
  failures: number;
}> {
  const rows: Array<{ englishName: string; wikitext: string }> = [];
  let failures = 0;
  const fetchOne = async (englishName: string): Promise<void> => {
    const page = encodeURIComponent(englishName.replace(/ /g, "_"));
    try {
      const response = await fetch(
        `https://reverse1999.fandom.com/api.php?action=parse&page=${page}&format=json&prop=wikitext&origin=*`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!response.ok) {
        failures++;
        return;
      }
      const data = (await response.json()) as {
        parse?: { wikitext?: { "*"?: string } };
      };
      rows.push({
        englishName,
        wikitext: data.parse?.wikitext?.["*"] ?? "",
      });
    } catch {
      failures++;
    }
  };

  for (let index = 0; index < englishNames.length; index += 8) {
    await Promise.all(englishNames.slice(index, index + 8).map(fetchOne));
  }
  return { rows, failures };
}

export function parseJapaneseNameOverrides(
  raw: string,
  source = "Japanese name overrides"
): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new NameConfigurationError(
      source,
      `${source} is not valid JSON`,
      { cause: error }
    );
  }
  if (!Array.isArray(value)) {
    throw new NameConfigurationError(source, `${source} must be an array`);
  }
  const output: Record<string, string> = {};
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      !("jpName" in entry) ||
      !("enName" in entry) ||
      typeof entry.jpName !== "string" ||
      !entry.jpName.trim() ||
      typeof entry.enName !== "string" ||
      !entry.enName.trim()
    ) {
      throw new NameConfigurationError(
        source,
        `invalid override at index ${index}`
      );
    }
    if (entry.jpName in output) {
      throw new NameConfigurationError(
        source,
        `duplicate Japanese override ${JSON.stringify(entry.jpName)}`
      );
    }
    output[entry.jpName] = entry.enName;
  }
  return output;
}

export async function loadJapaneseNameOverrides(
  file: string
): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new NameConfigurationError(
      file,
      `Japanese name override file is unavailable: ${file}`,
      { cause: error }
    );
  }
  return parseJapaneseNameOverrides(raw, file);
}

/** Fetch, normalize and atomically install one complete source generation. */
export async function refreshNameSourceCache(options: {
  japaneseOverridesFile: string;
  cacheFile?: string;
}): Promise<NameSourceSnapshot> {
  // Checked-in local configuration is authoritative. Validate it before any
  // upstream acquisition so it can never be hidden by last-known-good fallback.
  const japaneseOverrides = await loadJapaneseNameOverrides(
    options.japaneseOverridesFile
  );

  const rawKornblumeNames = {} as Record<NameLang, string>;
  for (const lang of NAME_LANGS) {
    rawKornblumeNames[lang] = fetchText(
      `${KORNBLUME_BASE}/lang/static/arcanists/${lang}.json`
    );
  }
  const rawKornblumeArcanists = fetchText(
    `${KORNBLUME_BASE}/public/data/arcanists.json`
  );
  const kornblume = parseKornblumeSource(
    rawKornblumeNames,
    rawKornblumeArcanists
  );

  const rawWikiRu = fetchText(WIKIRU_JP_URL);
  const wikiRuJa = parseWikiRuJapaneseSource(
    rawWikiRu,
    kornblume.namesByLang["ja-JP"],
    japaneseOverrides
  );

  const fandom = await fetchFandomRows(
    kornblume.arcanists.map((entry) => entry.name)
  );
  const fandomKr = normalizeFandomKoreanSource(fandom.rows, fandom.failures);

  const rawGlobalCharacters = fetchText(GLOBAL_CHARACTER_URL);
  const rawGlobalLanguages = {} as Record<NameLang, string>;
  for (const lang of NAME_LANGS) {
    rawGlobalLanguages[lang] = fetchText(
      `${GLOBAL_LANGUAGE_BASE}/${GLOBAL_LANGUAGE_FILES[lang]}`,
      40 * 1024 * 1024
    );
  }
  const globalNamesByLang = parseGlobalSource(
    rawGlobalCharacters,
    rawGlobalLanguages
  );

  const snapshot = createNameSourceSnapshot({
    kornblume,
    wikiRuJa,
    fandomKr,
    globalNamesByLang,
  });

  const cacheFile = options.cacheFile ?? NAME_SOURCE_CACHE_FILE;
  const installResult = await installNameSourceCache(snapshot, cacheFile);
  if (installResult.backupPath) {
    console.warn(
      `⚠ name source cache committed; old backup cleanup failed and was left at ${installResult.backupPath}`
    );
  }
  return snapshot;
}
