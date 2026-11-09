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
    { baseId: 1, "ja-JP": "Manual Alpha" },
    { baseId: 2, "ja-JP": "Manual Beta" },
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
console.log("ok: pure name policy preserves precedence, mutations, diagnostics, and ordering");

const renamedEnglishSnapshot: NameSourceSnapshot = {
  ...fixtureSnapshot,
  globalNamesByLang: {
    ...fixtureSnapshot.globalNamesByLang,
    "ja-JP": { ...fixtureSnapshot.globalNamesByLang["ja-JP"], "7": "GL 改名 JA" },
  },
};
const renamedEnglishResult = applyNamePolicy({
  characters: [character("renamed", 7, { names: { "en-US": "Renamed English" } })],
  arcanists: [{ id: 7, name: "庚", nameEng: "Old English" }],
  snapshot: renamedEnglishSnapshot,
  localizedOverrides: [
    { baseId: 7, "ja-JP": "Manual 改名 JA", "ko-KR": "Manual 改名 KO" },
  ],
});
const renamedEnglish = renamedEnglishResult.characters[0];
assert.equal(
  renamedEnglishResult.summary.localizedOverrideFieldsApplied,
  2,
  "both manual locale fields are applied by Base ID before GL"
);
assert.equal(
  renamedEnglish?.names?.["en-US"],
  "Renamed English",
  "existing English is preserved when no upstream English exists"
);
assert.equal(
  renamedEnglish?.names?.["ja-JP"],
  "GL 改名 JA",
  "GL still wins over a Base ID manual override"
);
assert.equal(
  renamedEnglish?.names?.["ko-KR"],
  "Manual 改名 KO",
  "Base ID manual override still applies after the English display name changes"
);

const invalidOverrideCases: Array<[string, unknown, RegExp]> = [
  ["array shape", { baseId: 1 }, /localized overrides must be an array/],
  ["row shape", [null], /invalid localized override at index 0/],
  [
    "legacy English key",
    [{ nameEng: "Fallback Alpha", "ja-JP": "なし" }],
    /invalid localized override Base ID at index 0/,
  ],
  [
    "non-numeric Base ID",
    [{ baseId: "1", "ja-JP": "なし" }],
    /invalid localized override Base ID at index 0/,
  ],
  [
    "non-positive Base ID",
    [{ baseId: 0, "ja-JP": "なし" }],
    /invalid localized override Base ID at index 0/,
  ],
  [
    "unknown Base ID",
    [{ baseId: 999, "ja-JP": "なし" }],
    /localized override Base ID 999 not found in characters/,
  ],
  [
    "duplicate Base ID",
    [
      { baseId: 1, "ja-JP": "一" },
      { baseId: 1, "ja-JP": "二" },
    ],
    /duplicate localized override Base ID 1/,
  ],
  [
    "unsupported locale",
    [{ baseId: 1, en: "Alpha" }],
    /unsupported localized override field "en"/,
  ],
  [
    "empty locale",
    [{ baseId: 1, "ja-JP": "  " }],
    /localized override ja-JP for Base ID 1 must be a nonempty string/,
  ],
  ["no locale fields", [{ baseId: 1 }], /localized override Base ID 1 has no locale names/],
];
for (const [label, localizedOverrides, pattern] of invalidOverrideCases) {
  assert.throws(
    () =>
      applyNamePolicy({
        characters: [character("alpha", 1)],
        arcanists: [{ id: 1, name: "甲", nameEng: "Alpha CN" }],
        snapshot: fixtureSnapshot,
        localizedOverrides,
      }),
    (error: unknown) =>
      error instanceof NamePolicyError && pattern.test(error.message),
    label
  );
}
console.log("ok: manual localized overrides validate Base ID and locales at the policy seam");

// A Wiki rarity must survive when ArcanistMap knows the character but Kornblume does not.
const noKornblumeResult = applyNamePolicy({
  characters: [character("wiki-only", 900, { rarity: 3 })],
  arcanists: [{ id: 900, name: "No Kornblume", nameEng: "No Kornblume" }],
  snapshot: fixtureSnapshot,
  localizedOverrides: [],
});
assert.equal(
  noKornblumeResult.characters[0]?.rarity,
  3,
  "mapped characters retain Wiki rarity without a Kornblume match"
);

const supplementResult = applyNamePolicy({
  characters: [
    character("uttu-new", 123, {
      names: {
        "zh-CN": "既有中文",
        "en-US": "Existing English",
        "ja-JP": "Manual Japanese",
      },
    }),
  ],
  arcanists: [],
  snapshot: fixtureSnapshot,
  localizedOverrides: [],
  supplementMetadata: [
    {
      baseId: 123,
      names: {
        "zh-CN": "UTTU 中文",
        "zh-TW": "UTTU 繁體",
        "en-US": "UTTU English",
        "ja-JP": "UTTU Japanese",
      },
      rarity: 4,
    },
  ],
});
const supplementCharacter = supplementResult.characters[0];
assert.equal(supplementCharacter?.names?.["zh-CN"], "既有中文", "supplement does not overwrite an existing CN name");
assert.equal(supplementCharacter?.names?.["en-US"], "Existing English", "supplement does not overwrite an existing English name");
assert.equal(supplementCharacter?.names?.["ja-JP"], "Manual Japanese", "an existing Japanese name is preserved over the UTTU fallback");
assert.equal(supplementCharacter?.names?.["zh-TW"], "UTTU 繁體", "UTTU fills only still-empty languages");
assert.equal(supplementCharacter?.rarity, 4, "supplement seeds rarity without a Kornblume match");
assert.equal(
  supplementResult.diagnostics.some((entry) => entry.characterId === "uttu-new"),
  false,
  "an admitted supplement character is not reported as an unknown ArcanistMap character"
);

// Incomplete-source fixture: a language missing upstream must not erase the persisted value.
const partialKornblumeSnapshot: NameSourceSnapshot = {
  ...fixtureSnapshot,
  kornblume: {
    namesByLang: {
      ...fixtureSnapshot.kornblume.namesByLang,
      "zh-CN": {
        ...fixtureSnapshot.kornblume.namesByLang["zh-CN"],
        "partial-eta": "己",
      },
      "en-US": {
        ...fixtureSnapshot.kornblume.namesByLang["en-US"],
        "partial-eta": "Partial Eta",
      },
    },
    arcanists: [
      ...fixtureSnapshot.kornblume.arcanists,
      { id: 40, name: "Partial Eta", rarity: 5 },
    ],
  },
};
const etaArcanists: ArcanistMapEntry[] = [{ id: 9, name: "己", nameEng: "Eta CN" }];
const liveUttuResult = applyNamePolicy({
  characters: [
    character("eta", 9, {
      names: {
        "zh-CN": "既有己",
        "en-US": "Existing Eta",
        "ja-JP": "既存のエータ",
      },
    }),
  ],
  arcanists: etaArcanists,
  snapshot: partialKornblumeSnapshot,
  localizedOverrides: [],
  uttuNames: [{ baseId: 9, names: { "ja-JP": "UTTU エータ", "ko-KR": "UTTU 한국" } }],
});
const eta = liveUttuResult.characters[0];
assert.equal(eta?.names?.["zh-CN"], "己", "Kornblume still overrides an existing CN name");
assert.equal(eta?.names?.["en-US"], "Partial Eta");
assert.equal(eta?.names?.["ja-JP"], "既存のエータ", "persisted Japanese outranks live UTTU");
assert.equal(eta?.names?.["ko-KR"], "UTTU 한국", "live UTTU fills only an empty Korean name");

const offlineSecondPass = applyNamePolicy({
  characters: liveUttuResult.characters,
  arcanists: etaArcanists,
  snapshot: partialKornblumeSnapshot,
  localizedOverrides: [],
});
assert.equal(
  offlineSecondPass.characters[0]?.names?.["ko-KR"],
  "UTTU 한국",
  "a UTTU-filled name survives a later run where live profiles are unavailable"
);
assert.equal(offlineSecondPass.characters[0]?.names?.["ja-JP"], "既存のエータ");
console.log("ok: live UTTU names fill only empty locales and persist across runs");

const fallbackResult = applyNamePolicy({
  characters: [
    character("existing-only", 998, {
      names: { "en-US": "  Existing Only  " },
    }),
    character("unnamed", 997),
    character("uttu-only", 996),
  ],
  arcanists: [],
  snapshot: fixtureSnapshot,
  localizedOverrides: [],
  uttuNames: [{ baseId: 996, names: { "en-US": "UTTU Only" } }],
});
assert.equal(
  fallbackResult.characters.find((entry) => entry.id === "existing-only")
    ?.names?.["en-US"],
  "Existing Only",
  "existing English is preserved when normalized sources have no match"
);
assert.equal(
  fallbackResult.characters.find((entry) => entry.id === "uttu-only")
    ?.names?.["en-US"],
  "UTTU Only",
  "live UTTU English counts as a fallback"
);
assert.equal(fallbackResult.summary.englishFallback, 2);
assert.equal(fallbackResult.summary.englishMissing, 1);
assert.equal(
  fallbackResult.summary.missingByLang["en-US"],
  fallbackResult.summary.englishMissing,
  "English coverage counters describe the final output"
);

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

let invalidOverrideWrite = false;
await assert.rejects(
  () =>
    runNameSync({
      refreshSources: async () => {
        throw new NameSourceError("transport", "fixture", "offline");
      },
      loadCachedSources: async () => fixtureSnapshot,
      cacheExists: () => true,
      loadCharacters: () => [character("alpha", 1)],
      loadArcanists: () => [{ id: 1, name: "甲", nameEng: "Alpha CN" }],
      loadLocalizedOverrides: () => [{ baseId: 999, "ja-JP": "なし" }],
      writeCharacters: () => {
        invalidOverrideWrite = true;
      },
      warn: () => {},
    }),
  (error) =>
    error instanceof NamePolicyError &&
    /localized override Base ID 999 not found in characters/.test(error.message),
  "an invalid manual Base ID aborts after LKG selection instead of being written or ignored"
);
assert.equal(invalidOverrideWrite, false, "invalid manual config never writes characters");
console.log("ok: invalid manual config cannot be hidden by last-known-good sources");

let uttuWiredWrite: Character[] | undefined;
const uttuWiredWarnings: string[] = [];
const uttuWiredResult = await runNameSync({
  refreshSources: async () => fixtureSnapshot,
  loadCachedSources: async () => fixtureSnapshot,
  cacheExists: () => false,
  refreshUttuNames: async () => ({
    names: [{ baseId: 9, names: { "ko-KR": "UTTU 한국" } }],
    diagnostics: ["UTTU profile 3155 has no usable zh name; skipped"],
  }),
  loadCharacters: () => [
    character("eta", 9, { names: { "zh-CN": "既有己", "en-US": "Existing Eta" } }),
  ],
  loadArcanists: () => etaArcanists,
  loadLocalizedOverrides: () => [],
  writeCharacters: (characters) => {
    uttuWiredWrite = characters;
  },
  warn: (message) => uttuWiredWarnings.push(message),
});
assert.equal(uttuWiredResult.sourceMode, "refreshed");
assert.equal(uttuWiredWrite?.[0]?.names?.["ko-KR"], "UTTU 한국");
assert.deepEqual(
  uttuWiredWarnings,
  ["UTTU profile 3155 has no usable zh name; skipped"],
  "UTTU parser diagnostics are forwarded through the existing warning channel"
);
console.log("ok: orchestration passes live UTTU names into the pure policy");

let uttuFailureWrite: Character[] | undefined;
const uttuFailureWarnings: string[] = [];
const uttuFailureResult = await runNameSync({
  refreshSources: async () => fixtureSnapshot,
  loadCachedSources: async () => fixtureSnapshot,
  cacheExists: () => false,
  refreshUttuNames: async () => {
    throw new NameSourceError("transport", "UTTU profiles", "offline");
  },
  loadCharacters: () => [
    character("beta", 2, { names: { "en-US": "Existing Beta" } }),
  ],
  loadArcanists: () => [{ id: 2, name: "乙", nameEng: "Beta CN" }],
  loadLocalizedOverrides: () => [],
  writeCharacters: (characters) => {
    uttuFailureWrite = characters;
  },
  warn: (message) => uttuFailureWarnings.push(message),
});
assert.equal(
  uttuFailureResult.sourceMode,
  "refreshed",
  "a UTTU failure never forces the primary sources into LKG"
);
assert.equal(uttuFailureWrite?.[0]?.names?.["en-US"], "Fallback Beta");
assert.match(uttuFailureWarnings[0] ?? "", /UTTU name fallback unavailable/);
console.log("ok: UTTU acquisition failure warns and still writes primary-source names");

let unexpectedWrite = false;
await assert.rejects(
  () =>
    runNameSync({
      refreshSources: async () => fixtureSnapshot,
      loadCachedSources: async () => fixtureSnapshot,
      cacheExists: () => false,
      refreshUttuNames: async () => {
        throw new Error("unexpected UTTU bug");
      },
      loadCharacters: () => [],
      loadArcanists: () => [],
      loadLocalizedOverrides: () => [],
      writeCharacters: () => {
        unexpectedWrite = true;
      },
      warn: () => {},
    }),
  /unexpected UTTU bug/,
  "unexpected UTTU errors are not swallowed"
);
assert.equal(unexpectedWrite, false);
console.log("ok: unexpected UTTU errors abort instead of reading as an empty catalog");
