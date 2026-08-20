import {
  buildGlobalEnglishNames,
  normalizeGlobalEnglishName,
  resolveEnglishName,
  type GlobalCharacterEntry,
  type GlobalLocalizationEntry,
} from "./english-name";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

const globalCharacters: GlobalCharacterEntry[] = [
  { id: 1001, name: "language_name_1001", nameEng: "Wrong Internal Name" },
  { id: 1002, name: "language_name_1002", nameEng: "Another Wrong Name" },
  { id: 1005, name: "language_name_1005", nameEng: "Unused NameEng" },
  { id: 1006, name: "language_missing", nameEng: "Missing Key Name" },
];
const languageEn: GlobalLocalizationEntry[] = [
  { key: "language_name_1001", content: "<i>Global Name</i>" },
  { key: "language_name_1002", content: "   " },
  { key: "language_name_1005", content: "<color=#fff>Color Name</color>" },
];
const globalNames = buildGlobalEnglishNames(globalCharacters, languageEn);
assert(globalNames.get(1001) === "Global Name", "ID → key → content resolves and strips rich-text");
assert(!globalNames.has(1002), "empty localized content is treated as missing");
assert(globalNames.get(1005) === "Color Name", "known Unity color tags are stripped");
assert(!globalNames.has(1006), "missing localization key does not use nameEng");
assert(normalizeGlobalEnglishName("<i>Lady by the Lake</i>") === "Lady by the Lake", "italic tags normalize");
assert(normalizeGlobalEnglishName("A < 3") === "A < 3", "ordinary angle brackets are preserved");

const global = resolveEnglishName(globalNames, 1001, "Kornblume Name", "Existing Name");
assert(global.name === "Global Name", "Global localized content wins");
assert(global.source === "global", "Global result reports global source");

const fallback = resolveEnglishName(globalNames, 1002, "Kornblume Name", "Existing Name");
assert(fallback.name === "Kornblume Name", "empty Global content falls back to Kornblume");
assert(fallback.source === "fallback", "Kornblume result reports fallback source");

const fallbackWithoutGlobalId = resolveEnglishName(globalNames, 1003, "Kornblume Name", "Existing Name");
assert(
  fallbackWithoutGlobalId.name === "Kornblume Name",
  "missing Global ID falls back to Kornblume"
);
assert(fallbackWithoutGlobalId.source === "fallback", "missing Global ID reports fallback source");

const existing = resolveEnglishName(new Map(), 1004, "", "  Existing Name  ");
assert(existing.name === "Existing Name", "missing fallback preserves existing English name");
assert(existing.source === "existing", "existing result reports existing source");

const missing = resolveEnglishName(new Map(), 1007, undefined, "   ");
assert(missing.name === undefined, "missing Global, fallback, and existing names stay missing");
assert(missing.source === "missing", "missing result reports missing source");

const localized = {
  "zh-CN": "中文名",
  "zh-TW": "繁中名",
  "ja-JP": "日本語名",
  "ko-KR": "한국어 이름",
};
const resolved = resolveEnglishName(globalNames, 1001, "Fallback", undefined);
const names = { ...localized, ...(resolved.name ? { "en-US": resolved.name } : {}) };
assert(names["zh-CN"] === "中文名", "zh-CN is unchanged");
assert(names["zh-TW"] === "繁中名", "zh-TW is unchanged");
assert(names["ja-JP"] === "日本語名", "ja-JP is unchanged");
assert(names["ko-KR"] === "한국어 이름", "ko-KR is unchanged");
assert(names["en-US"] === "Global Name", "only en-US receives the resolved name");
