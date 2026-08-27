import {
  buildGlobalLocalizedNames,
  type GlobalCharacterEntry,
  type GlobalLocalizationEntry,
} from "./global-localization";

export const NAME_LANGS = ["zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR"] as const;
export type NameLang = (typeof NAME_LANGS)[number];

export interface KornblumeArcanist {
  id: number;
  name: string;
  rarity: number;
}

export interface KornblumeNameSource {
  namesByLang: Record<NameLang, Record<string, string>>;
  arcanists: KornblumeArcanist[];
}

export interface NameSourceSnapshot {
  schemaVersion: 1;
  kornblume: KornblumeNameSource;
  wikiRuJa: Record<string, string>;
  fandomKr: Record<string, string>;
  globalNamesByLang: Record<NameLang, Record<string, string>>;
}

export type NameSourceErrorKind =
  | "transport"
  | "parse"
  | "validation"
  | "cache";

export interface NameSourceErrorOptions extends ErrorOptions {
  recoverableWithLkg?: boolean;
  recoveryPath?: string;
}

export class NameSourceError extends Error {
  readonly kind: NameSourceErrorKind;
  readonly source: string;
  readonly recoverableWithLkg: boolean;
  readonly recoveryPath?: string;

  constructor(
    kind: NameSourceErrorKind,
    source: string,
    message: string,
    options: NameSourceErrorOptions = {}
  ) {
    super(message, options);
    this.name = "NameSourceError";
    this.kind = kind;
    this.source = source;
    this.recoverableWithLkg = options.recoverableWithLkg ?? true;
    this.recoveryPath = options.recoveryPath;
  }
}

/** Local checked-in configuration errors must never silently use stale sources. */
export class NameConfigurationError extends Error {
  readonly recoverableWithLkg = false;
  readonly source: string;

  constructor(source: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NameConfigurationError";
    this.source = source;
  }
}

const MIN_KORNBLUME_NAMES = 100;
const MIN_KORNBLUME_ARCANISTS = 100;
const MIN_KORNBLUME_CROSS_SOURCE_MATCHES = 80;
const MIN_GLOBAL_CHARACTERS = 100;
const MIN_GLOBAL_LOCALIZATIONS = 10_000;
const MIN_GLOBAL_NORMALIZED_NAMES = 100;
const MIN_WIKIRU_NAMES = 30;
const MIN_FANDOM_NAMES = 30;
/** Druvis III is a launch character and a stable package-generation sentinel. */
const GLOBAL_SENTINEL_ID = 3003;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(source: string, raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new NameSourceError(
      "parse",
      source,
      `${source} is not valid JSON`,
      { cause: error }
    );
  }
}

function assertNonEmptyNameRecord(
  source: string,
  value: unknown,
  minimum: number
): asserts value is Record<string, string> {
  if (!isRecord(value)) {
    throw new NameSourceError("validation", source, `${source} must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length < minimum) {
    throw new NameSourceError(
      "validation",
      source,
      `${source} is truncated: ${entries.length} < ${minimum}`
    );
  }
  for (const [key, name] of entries) {
    if (!key.trim() || typeof name !== "string" || !name.trim()) {
      throw new NameSourceError(
        "validation",
        source,
        `${source} contains an empty or non-string name`
      );
    }
  }
}

export function slugifyName(name: string): string {
  const lower = name.toLowerCase().trim();
  if (/^\d+$/.test(lower)) return lower;
  return lower.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
}

export function parseKornblumeSource(
  rawNamesByLang: Record<NameLang, string>,
  rawArcanists: string
): KornblumeNameSource {
  const namesByLang = {} as Record<NameLang, Record<string, string>>;
  for (const lang of NAME_LANGS) {
    const parsed = parseJson(`Kornblume ${lang}`, rawNamesByLang[lang]);
    assertNonEmptyNameRecord(
      `Kornblume ${lang}`,
      parsed,
      MIN_KORNBLUME_NAMES
    );
    namesByLang[lang] = { ...parsed };
  }

  const rawMetadata = parseJson("Kornblume arcanists", rawArcanists);
  if (!Array.isArray(rawMetadata) || rawMetadata.length < MIN_KORNBLUME_ARCANISTS) {
    throw new NameSourceError(
      "validation",
      "Kornblume arcanists",
      `Kornblume arcanists is truncated: ${Array.isArray(rawMetadata) ? rawMetadata.length : 0}`
    );
  }

  const ids = new Set<number>();
  const slugs = new Set<string>();
  const arcanists: KornblumeArcanist[] = rawMetadata.map((entry, index) => {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.Id) ||
      typeof entry.Name !== "string" ||
      !entry.Name.trim() ||
      !Number.isInteger(entry.Rarity) ||
      Number(entry.Rarity) < 1
    ) {
      throw new NameSourceError(
        "validation",
        "Kornblume arcanists",
        `invalid arcanist at index ${index}`
      );
    }
    const id = Number(entry.Id);
    if (ids.has(id)) {
      throw new NameSourceError(
        "validation",
        "Kornblume arcanists",
        `duplicate arcanist ID ${id}`
      );
    }
    ids.add(id);
    const name = entry.Name.trim();
    const slug = slugifyName(name);
    if (!slug || slugs.has(slug)) {
      throw new NameSourceError(
        "validation",
        "Kornblume arcanists",
        `duplicate or empty arcanist slug ${JSON.stringify(slug)}`
      );
    }
    slugs.add(slug);
    return { id, name, rarity: Number(entry.Rarity) };
  });

  const metadataMatches = arcanists.filter(
    (entry) => namesByLang["en-US"][slugifyName(entry.name)] === entry.name
  ).length;
  const sharedLanguageSlugs = Object.keys(namesByLang["zh-CN"]).filter((slug) =>
    NAME_LANGS.every((lang) => Boolean(namesByLang[lang][slug]))
  ).length;
  if (
    metadataMatches < MIN_KORNBLUME_CROSS_SOURCE_MATCHES ||
    sharedLanguageSlugs < MIN_KORNBLUME_CROSS_SOURCE_MATCHES
  ) {
    throw new NameSourceError(
      "validation",
      "Kornblume",
      `cross-source coverage failed: metadata=${metadataMatches}, languages=${sharedLanguageSlugs}`
    );
  }

  return { namesByLang, arcanists };
}

function assertGlobalCharacters(value: unknown): asserts value is GlobalCharacterEntry[] {
  if (!Array.isArray(value) || value.length < MIN_GLOBAL_CHARACTERS) {
    throw new NameSourceError(
      "validation",
      "Global character.json",
      `Global character.json is truncated: ${Array.isArray(value) ? value.length : 0}`
    );
  }
  const ids = new Set<number>();
  for (const [index, entry] of value.entries()) {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.id) ||
      typeof entry.name !== "string" ||
      !entry.name.trim()
    ) {
      throw new NameSourceError(
        "validation",
        "Global character.json",
        `invalid character at index ${index}`
      );
    }
    const id = Number(entry.id);
    if (ids.has(id)) {
      throw new NameSourceError(
        "validation",
        "Global character.json",
        `duplicate character ID ${id}`
      );
    }
    ids.add(id);
  }
  if (!ids.has(GLOBAL_SENTINEL_ID)) {
    throw new NameSourceError(
      "validation",
      "Global character.json",
      `missing stable launch sentinel ${GLOBAL_SENTINEL_ID}`
    );
  }
}

function parseGlobalLanguage(source: string, raw: string): GlobalLocalizationEntry[] {
  const value = parseJson(source, raw);
  if (!Array.isArray(value) || value.length < MIN_GLOBAL_LOCALIZATIONS) {
    throw new NameSourceError(
      "validation",
      source,
      `${source} is truncated: ${Array.isArray(value) ? value.length : 0}`
    );
  }
  const keys = new Set<string>();
  return value.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      !entry.key.trim() ||
      typeof entry.content !== "string"
    ) {
      throw new NameSourceError(
        "validation",
        source,
        `invalid localization at index ${index}`
      );
    }
    const key = entry.key.trim();
    if (keys.has(key)) {
      throw new NameSourceError("validation", source, `duplicate localization key ${key}`);
    }
    keys.add(key);
    return { key, content: entry.content };
  });
}

export function parseGlobalSource(
  rawCharacters: string,
  rawLanguages: Record<NameLang, string>
): Record<NameLang, Record<string, string>> {
  const charactersValue = parseJson("Global character.json", rawCharacters);
  assertGlobalCharacters(charactersValue);
  const characters = charactersValue;
  const output = {} as Record<NameLang, Record<string, string>>;

  for (const lang of NAME_LANGS) {
    const localizations = parseGlobalLanguage(`Global ${lang}`, rawLanguages[lang]);
    const names = buildGlobalLocalizedNames(characters, localizations);
    if (names.size < MIN_GLOBAL_NORMALIZED_NAMES || !names.has(GLOBAL_SENTINEL_ID)) {
      throw new NameSourceError(
        "validation",
        `Global ${lang}`,
        `normalized coverage failed: ${names.size} names or missing sentinel ${GLOBAL_SENTINEL_ID}`
      );
    }
    output[lang] = Object.fromEntries(
      [...names.entries()].sort(([left], [right]) => left - right).map(([id, name]) => [String(id), name])
    );
  }
  return output;
}

export function parseWikiRuJapaneseSource(
  markdown: string,
  kornblumeJapanese: Readonly<Record<string, string>>,
  japaneseToEnglishOverrides: Readonly<Record<string, string>>
): Record<string, string> {
  const result: Record<string, string> = {};
  const japaneseToSlug = new Map(
    Object.entries(kornblumeJapanese).map(([slug, name]) => [name, slug])
  );
  let index = 0;
  while (true) {
    const start = markdown.indexOf("attach2/", index);
    if (start < 0) break;
    index = start + 8;
    let hex = "";
    let cursor = index;
    while (cursor < markdown.length && /[0-9a-fA-F_]/.test(markdown[cursor])) {
      hex += markdown[cursor++];
    }
    if (!markdown.startsWith(".png) ", cursor)) continue;
    const end = markdown.indexOf("](", cursor + 6);
    if (end < 0) continue;
    const japaneseName = markdown.slice(cursor + 6, end).trim();
    const cleanHex = hex.replace(/_/g, "");
    if (!japaneseName || !cleanHex || cleanHex.length % 2 !== 0) continue;
    const decoded = Buffer.from(cleanHex, "hex").toString("utf8");
    if (
      decoded.includes("�") ||
      !decoded.startsWith("img") ||
      !decoded.includes("_icon")
    ) {
      continue;
    }
    const iconName = decoded.slice(3, decoded.indexOf("_icon")).trim();
    const isLatin = /^[\p{Script=Latin}\p{N} .,'\-]+$/u.test(iconName);
    const slug = isLatin
      ? slugifyName(iconName)
      : japaneseToSlug.get(japaneseName) ??
        (japaneseToEnglishOverrides[japaneseName]
          ? slugifyName(japaneseToEnglishOverrides[japaneseName])
          : undefined);
    if (slug) result[slug] = japaneseName;
  }
  assertNonEmptyNameRecord("WikiRu Japanese", result, MIN_WIKIRU_NAMES);
  return result;
}

export function parseFandomKoreanName(wikitext: string): string | undefined {
  const marker = "name_kor=";
  const markerIndex = wikitext.indexOf(marker);
  if (markerIndex < 0) return undefined;
  let name = wikitext.slice(markerIndex + marker.length).trim();
  const end = name.search(/[\n|]/);
  if (end >= 0) name = name.slice(0, end).trim();
  if (!name || /[{}[\]]/.test(name)) return undefined;
  return name;
}

export function normalizeFandomKoreanSource(
  rows: readonly { englishName: string; wikitext: string }[],
  fetchFailures: number
): Record<string, string> {
  if (fetchFailures > 0) {
    throw new NameSourceError(
      "transport",
      "Fandom Korean",
      `incomplete Fandom acquisition: ${fetchFailures} fetch failure(s)`
    );
  }
  const result: Record<string, string> = {};
  const orderedRows = [...rows].sort((left, right) =>
    left.englishName < right.englishName
      ? -1
      : left.englishName > right.englishName
        ? 1
        : 0
  );
  for (const row of orderedRows) {
    const name = parseFandomKoreanName(row.wikitext);
    if (name) result[slugifyName(row.englishName)] = name;
  }
  assertNonEmptyNameRecord("Fandom Korean", result, MIN_FANDOM_NAMES);
  return result;
}

export function validateNameSourceSnapshot(
  value: unknown
): asserts value is NameSourceSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new NameSourceError("validation", "name source cache", "unsupported schema");
  }
  if (!isRecord(value.kornblume) || !isRecord(value.kornblume.namesByLang)) {
    throw new NameSourceError("validation", "name source cache", "invalid Kornblume snapshot");
  }
  const cachedNamesByLang = value.kornblume.namesByLang as Record<
    NameLang,
    Record<string, string>
  >;
  for (const lang of NAME_LANGS) {
    assertNonEmptyNameRecord(
      `cached Kornblume ${lang}`,
      cachedNamesByLang[lang],
      MIN_KORNBLUME_NAMES
    );
  }
  if (!Array.isArray(value.kornblume.arcanists) || value.kornblume.arcanists.length < MIN_KORNBLUME_ARCANISTS) {
    throw new NameSourceError("validation", "name source cache", "cached arcanists are truncated");
  }
  const cachedArcanists = value.kornblume.arcanists;
  const arcanistIds = new Set<number>();
  const cachedArcanistSlugs = new Set<string>();
  for (const entry of cachedArcanists) {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.id) ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      !Number.isInteger(entry.rarity) ||
      Number(entry.rarity) < 1
    ) {
      throw new NameSourceError("validation", "name source cache", "invalid cached arcanist");
    }
    const id = Number(entry.id);
    if (arcanistIds.has(id)) {
      throw new NameSourceError("validation", "name source cache", `duplicate cached arcanist ID ${id}`);
    }
    arcanistIds.add(id);
    const slug = slugifyName(entry.name);
    if (!slug || cachedArcanistSlugs.has(slug)) {
      throw new NameSourceError(
        "validation",
        "name source cache",
        `duplicate or empty cached arcanist slug ${JSON.stringify(slug)}`
      );
    }
    cachedArcanistSlugs.add(slug);
  }
  const cachedMetadataMatches = cachedArcanists.filter(
    (entry) =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      cachedNamesByLang["en-US"][slugifyName(entry.name)] === entry.name
  ).length;
  const cachedSharedLanguageSlugs = Object.keys(
    cachedNamesByLang["zh-CN"]
  ).filter((slug) =>
    NAME_LANGS.every((lang) => Boolean(cachedNamesByLang[lang][slug]))
  ).length;
  if (
    cachedMetadataMatches < MIN_KORNBLUME_CROSS_SOURCE_MATCHES ||
    cachedSharedLanguageSlugs < MIN_KORNBLUME_CROSS_SOURCE_MATCHES
  ) {
    throw new NameSourceError(
      "validation",
      "name source cache",
      "cached Kornblume cross-source coverage failed"
    );
  }

  assertNonEmptyNameRecord("cached WikiRu Japanese", value.wikiRuJa, MIN_WIKIRU_NAMES);
  assertNonEmptyNameRecord("cached Fandom Korean", value.fandomKr, MIN_FANDOM_NAMES);
  if (!isRecord(value.globalNamesByLang)) {
    throw new NameSourceError("validation", "name source cache", "invalid Global snapshot");
  }
  for (const lang of NAME_LANGS) {
    assertNonEmptyNameRecord(
      `cached Global ${lang}`,
      value.globalNamesByLang[lang],
      MIN_GLOBAL_NORMALIZED_NAMES
    );
    if (!(String(GLOBAL_SENTINEL_ID) in value.globalNamesByLang[lang])) {
      throw new NameSourceError(
        "validation",
        "name source cache",
        `cached Global ${lang} is missing sentinel ${GLOBAL_SENTINEL_ID}`
      );
    }
  }
}

export function createNameSourceSnapshot(input: {
  kornblume: KornblumeNameSource;
  wikiRuJa: Record<string, string>;
  fandomKr: Record<string, string>;
  globalNamesByLang: Record<NameLang, Record<string, string>>;
}): NameSourceSnapshot {
  const snapshot: NameSourceSnapshot = { schemaVersion: 1, ...input };
  validateNameSourceSnapshot(snapshot);
  return snapshot;
}
