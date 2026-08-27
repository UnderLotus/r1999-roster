import assert from "node:assert/strict";

import { parseJapaneseNameOverrides } from "./fetch-name-sources";

import {
  buildGlobalLocalizedNames,
  normalizeGlobalLocalizedName,
  type GlobalCharacterEntry,
  type GlobalLocalizationEntry,
} from "./global-localization";
import {
  applyNamePolicy,
  NamePolicyError,
  type ArcanistMapEntry,
} from "./name-policy";
import {
  NameConfigurationError,
  NameSourceError,
  type NameSourceSnapshot,
} from "./name-source";
import { runNameSync } from "./build-names";
import type { Character } from "./types";

const globalCharacters: GlobalCharacterEntry[] = [
  { id: 1001, name: "language_name_1001", nameEng: "Wrong Internal Name" },
  { id: 1002, name: "language_name_1002", nameEng: "Another Wrong Name" },
  { id: 1005, name: "language_name_1005", nameEng: "Unused NameEng" },
  { id: 1006, name: "language_missing", nameEng: "Missing Key Name" },
];
const language: GlobalLocalizationEntry[] = [
  { key: "language_name_1001", content: "<i>Global Name</i>" },
  { key: "language_name_1002", content: "   " },
  { key: "language_name_1005", content: "<color=#fff>Color Name</color>" },
];
const globalNames = buildGlobalLocalizedNames(globalCharacters, language);
assert.equal(globalNames.get(1001), "Global Name");
assert.equal(globalNames.has(1002), false);
assert.equal(globalNames.get(1005), "Color Name");
assert.equal(globalNames.has(1006), false);
assert.equal(normalizeGlobalLocalizedName("<i>Lady by the Lake</i>"), "Lady by the Lake");
assert.equal(normalizeGlobalLocalizedName("A < 3"), "A < 3");

console.log("ok: generic Global mapper is deterministic");

const fixtureSnapshot: NameSourceSnapshot = {
  schemaVersion: 1,
  kornblume: {
    namesByLang: {
      "zh-CN": {
        "fallback-alpha": "甲",
        "fallback-beta": "乙",
        "fallback-gamma": "丁",
        "fallback-delta": "戊",
      },
      "zh-TW": {
        "fallback-alpha": "甲繁",
        "fallback-beta": "乙繁",
        "fallback-gamma": "丁繁",
        "fallback-delta": "戊繁",
      },
      "en-US": {
        "fallback-alpha": "Fallback Alpha",
        "fallback-beta": "Fallback Beta",
        "fallback-gamma": "Fallback Gamma",
        "fallback-delta": "Fallback Delta",
      },
      "ja-JP": {
        "fallback-alpha": "アルファ",
        "fallback-gamma": "ガンマ",
        "fallback-delta": "デルタ",
      },
      "ko-KR": {
        "fallback-alpha": "알파",
        "fallback-gamma": "감마",
        "fallback-delta": "델타",
      },
    },
    arcanists: [
      { id: 20, name: "Fallback Alpha", rarity: 6 },
      { id: 10, name: "Fallback Beta", rarity: 5 },
      { id: 30, name: "Fallback Gamma", rarity: 5 },
      { id: 5, name: "Fallback Delta", rarity: 5 },
    ],
  },
  wikiRuJa: { "fallback-beta": "Wiki Beta" },
  fandomKr: { "fallback-beta": "Fandom Beta" },
  globalNamesByLang: {
    "zh-CN": { "1": "GL 甲" },
    "zh-TW": { "1": "GL 甲繁" },
    "en-US": { "1": "Global Alpha" },
    "ja-JP": { "1": "GL アルファ" },
    "ko-KR": { "1": "GL 알파" },
  },
};

function character(
  id: string,
  baseId: number,
  options: Partial<Character> = {}
): Character {
  return {
    id,
    name: `Character ${baseId}`,
    baseId,
    releaseOrder: baseId,
    enabled: true,
    stage: "pending-names",
    isReleased: false,
    skins: [],
    defaultVariant: `${baseId}01`,
    ...options,
  };
}

const characters: Character[] = [
  character("alpha", 1, {
    names: { "en-US": "Existing Alpha", "ja-JP": "Existing JA" },
    source: { pageUrl: "https://example.test/alpha" },
    releaseOrder: 8,
  }),
  character("beta", 2, { names: { "en-US": "Existing Beta" } }),
  character("gamma", 4, { releaseOrder: 1 }),
  character("delta", 5, { releaseOrder: 2 }),
  character("asset", 3),
  character("missing", 999),
];
const arcanists: ArcanistMapEntry[] = [
  { id: 1, name: "甲", nameEng: "Alpha CN" },
  { id: 2, name: "乙", nameEng: "Beta CN" },
  { id: 3, name: "丙", nameEng: "Gamma Baseline" },
  { id: 4, name: "丁", nameEng: "Gamma CN" },
  { id: 5, name: "戊", nameEng: "Delta CN" },
];
const originalCharacters = structuredClone(characters);
const result = applyNamePolicy({
  characters,
  arcanists,
  snapshot: fixtureSnapshot,
  localizedOverrides: [
    { nameEng: "Fallback Alpha", "ja-JP": "Manual Alpha" },
    { nameEng: "Fallback Beta", "ja-JP": "Manual Beta" },
    { nameEng: "Unknown Override", "ko-KR": "없음" },
  ],
});
assert.deepEqual(characters, originalCharacters, "policy does not mutate caller fixtures");
const alpha = result.characters.find((entry) => entry.id === "alpha");
const beta = result.characters.find((entry) => entry.id === "beta");
const asset = result.characters.find((entry) => entry.id === "asset");
const unmatched = result.characters.find((entry) => entry.id === "missing");
assert.equal(alpha?.names?.["en-US"], "Global Alpha", "Global English wins");
assert.equal(alpha?.names?.["ja-JP"], "GL アルファ", "Global localization wins over manual/lower sources");
assert.equal(beta?.names?.["en-US"], "Fallback Beta", "Kornblume English fallback is retained");
assert.equal(beta?.names?.["ja-JP"], "Manual Beta", "manual localization fills delayed upstream name");
assert.equal(beta?.names?.["ko-KR"], "Fandom Beta", "Fandom fills missing Korean name");
assert.equal(asset?.names?.["zh-CN"], "丙", "ArcanistMap supplies CN baseline");
assert.equal(asset?.names?.["en-US"], "Gamma Baseline", "ArcanistMap supplies English baseline");
assert.equal(unmatched?.names, undefined, "missing names are not invented or cleared");
assert.equal(alpha?.rarity, 6);
assert.equal(alpha?.stage, "live");
assert.equal(beta?.rarity, 5);
assert.equal(beta?.stage, "live");
assert.equal(result.characters.some((entry) => entry._kbId !== undefined), false);
assert.deepEqual(
  result.characters.map((entry) => entry.id),
  ["asset", "missing", "delta", "beta", "gamma", "alpha"],
  "same-rarity Kornblume IDs override opposite input/existing order"
);
assert.deepEqual(
  result.characters.map((entry) => entry.releaseOrder),
  [1, 2, 3, 4, 5, 6]
);
assert.equal(
  result.diagnostics.some((entry) => entry.characterId === "missing" && entry.kind === "missing-arcanist"),
  true,
  "missing character is a policy diagnostic"
);
assert.deepEqual(result.unmatchedLocalizedOverrides, ["Unknown Override"]);
console.log("ok: pure name policy preserves precedence, mutations, diagnostics, and ordering");

const fallbackResult = applyNamePolicy({
  characters: [
    character("existing-only", 998, {
      names: { "en-US": "  Existing Only  " },
    }),
    character("unnamed", 997),
  ],
  arcanists: [],
  snapshot: fixtureSnapshot,
  localizedOverrides: [],
});
assert.equal(
  fallbackResult.characters.find((entry) => entry.id === "existing-only")
    ?.names?.["en-US"],
  "Existing Only",
  "existing English is preserved when normalized sources have no match"
);
assert.equal(fallbackResult.summary.englishFallback, 1);
assert.equal(fallbackResult.summary.englishMissing, 1);

assert.throws(
  () =>
    applyNamePolicy({
      characters: [],
      arcanists: [
        { id: 1, name: "A", nameEng: "A" },
        { id: 1, name: "B", nameEng: "B" },
      ],
      snapshot: fixtureSnapshot,
      localizedOverrides: [],
    }),
  NamePolicyError,
  "invalid policy inputs are classified separately from source failures"
);

let written = false;
const warnings: string[] = [];
const syncResult = await runNameSync({
  refreshSources: async () => {
    throw new NameSourceError("transport", "fixture", "offline");
  },
  loadCachedSources: async () => fixtureSnapshot,
  cacheExists: () => true,
  loadCharacters: () => [],
  loadArcanists: () => [],
  loadLocalizedOverrides: () => [],
  writeCharacters: () => {
    written = true;
  },
  warn: (message) => warnings.push(message),
});
assert.equal(syncResult.sourceMode, "last-known-good");
assert.equal(written, true);
assert.match(warnings[0] ?? "", /transport\/fixture/);
console.log("ok: thin orchestration consumes LKG cache after classified source failure");

let configurationWriteCalled = false;
let configurationCacheRead = false;
await assert.rejects(
  () =>
    runNameSync({
      refreshSources: async () => {
        parseJapaneseNameOverrides("not-json", "jp-name-overrides.json");
        return fixtureSnapshot;
      },
      loadCachedSources: async () => {
        configurationCacheRead = true;
        return fixtureSnapshot;
      },
      cacheExists: () => true,
      loadCharacters: () => [],
      loadArcanists: () => [],
      loadLocalizedOverrides: () => [],
      writeCharacters: () => {
        configurationWriteCalled = true;
      },
      warn: () => {},
    }),
  (error) =>
    error instanceof NameConfigurationError &&
    error.recoverableWithLkg === false
);
assert.equal(configurationCacheRead, false, "local config failure cannot read LKG");
assert.equal(configurationWriteCalled, false, "local config failure aborts before output write");
console.log("ok: local configuration failure is non-recoverable even when LKG exists");
