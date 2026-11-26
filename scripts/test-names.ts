import assert from "node:assert/strict";

import { runNameSync } from "./build-names";
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
import type { Character } from "./types";

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
    "zh-CN": { "1": "GL 甲", "8": "APPLe" },
    "zh-TW": { "1": "GL 甲繁", "8": "APPLe" },
    "en-US": { "1": "Global Alpha", "8": "APPLe" },
    "ja-JP": { "1": "GL アルファ", "8": "APPLe" },
    "ko-KR": { "1": "GL 알파", "8": "애플" },
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

function testGlobalLocalization(): void {
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
}

function testNamePolicyPrecedenceAndOrdering(): void {
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
    character("apple", 8),
    character("missing", 999),
  ];
  const arcanists: ArcanistMapEntry[] = [
    { id: 1, name: "甲", nameEng: "Alpha CN" },
    { id: 2, name: "乙", nameEng: "Beta CN" },
    { id: 3, name: "丙", nameEng: "Gamma Baseline" },
    { id: 4, name: "丁", nameEng: "Gamma CN" },
    { id: 5, name: "戊", nameEng: "Delta CN" },
    { id: 8, name: "APPLe", nameEng: "APPLe" },
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
  assert.deepEqual(characters, originalCharacters, "policy never mutates caller fixtures");

  const byId = (id: string) => result.characters.find((entry) => entry.id === id);
  assert.equal(byId("alpha")?.names?.["en-US"], "Global Alpha", "Global English wins");
  assert.equal(byId("alpha")?.names?.["ja-JP"], "GL アルファ", "Global beats manual override");
  assert.equal(byId("beta")?.names?.["en-US"], "Fallback Beta", "Kornblume English fallback retained");
  assert.equal(byId("beta")?.names?.["ja-JP"], "Manual Beta", "manual override fills delayed upstream name");
  assert.equal(byId("beta")?.names?.["ko-KR"], "Fandom Beta", "Fandom fills missing Korean name");
  assert.equal(byId("asset")?.names?.["zh-CN"], "丙", "ArcanistMap supplies CN baseline");
  assert.equal(byId("asset")?.names?.["en-US"], "Gamma Baseline", "ArcanistMap supplies English baseline");
  assert.equal(
    byId("asset")?.names?.["ja-JP"],
    undefined,
    "CMP-09: missing locale stays absent instead of cross-filling English/CN"
  );
  assert.equal(
    byId("apple")?.names?.["ja-JP"],
    "APPLe",
    "CMP-09: genuine same-string Global localization is preserved"
  );
  assert.equal(byId("missing")?.names, undefined, "missing names are never invented");
  assert.equal(byId("alpha")?.rarity, 6);
  assert.equal(byId("alpha")?.stage, "live");
  assert.equal(byId("beta")?.rarity, 5);
  assert.equal(byId("beta")?.stage, "live");
  assert.equal(result.characters.some((entry) => entry._kbId !== undefined), false);
  assert.deepEqual(
    result.characters.map((entry) => entry.id),
    ["asset", "apple", "missing", "delta", "beta", "gamma", "alpha"]
  );
  assert.deepEqual(
    result.characters.map((entry) => entry.releaseOrder),
    [1, 2, 3, 4, 5, 6, 7]
  );
  assert.equal(
    result.diagnostics.some((entry) => entry.characterId === "missing" && entry.kind === "missing-arcanist"),
    true
  );

  // Wiki rarity survives when ArcanistMap knows the character but Kornblume does not.
  const wikiOnly = applyNamePolicy({
    characters: [character("wiki-only", 900, { rarity: 3 })],
    arcanists: [{ id: 900, name: "No Kornblume", nameEng: "No Kornblume" }],
    snapshot: fixtureSnapshot,
    localizedOverrides: [],
  });
  assert.equal(wikiOnly.characters[0]?.rarity, 3);

  // Duplicate ArcanistMap baseId fails as NamePolicyError.
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
    NamePolicyError
  );
}

function testLocalizedOverrides(): void {
  // Base ID manual overrides survive English display-name changes while Global still wins.
  const renamedSnapshot: NameSourceSnapshot = {
    ...fixtureSnapshot,
    globalNamesByLang: {
      ...fixtureSnapshot.globalNamesByLang,
      "ja-JP": { ...fixtureSnapshot.globalNamesByLang["ja-JP"], "7": "GL 改名 JA" },
    },
  };
  const renamed = applyNamePolicy({
    characters: [character("renamed", 7, { names: { "en-US": "Renamed English" } })],
    arcanists: [{ id: 7, name: "庚", nameEng: "Old English" }],
    snapshot: renamedSnapshot,
    localizedOverrides: [
      { baseId: 7, "ja-JP": "Manual 改名 JA", "ko-KR": "Manual 改名 KO" },
    ],
  });
  assert.equal(renamed.summary.localizedOverrideFieldsApplied, 2);
  assert.equal(renamed.characters[0]?.names?.["en-US"], "Renamed English");
  assert.equal(renamed.characters[0]?.names?.["ja-JP"], "GL 改名 JA");
  assert.equal(renamed.characters[0]?.names?.["ko-KR"], "Manual 改名 KO");

  const invalidCases: Array<[string, unknown, RegExp]> = [
    ["array shape", { baseId: 1 }, /localized overrides must be an array/],
    ["row shape", [null], /invalid localized override at index 0/],
    ["legacy English key", [{ nameEng: "Fallback Alpha", "ja-JP": "なし" }], /invalid localized override Base ID at index 0/],
    ["non-numeric Base ID", [{ baseId: "1", "ja-JP": "なし" }], /invalid localized override Base ID at index 0/],
    ["non-positive Base ID", [{ baseId: 0, "ja-JP": "なし" }], /invalid localized override Base ID at index 0/],
    ["unknown Base ID", [{ baseId: 999, "ja-JP": "なし" }], /localized override Base ID 999 not found in characters/],
    [
      "duplicate Base ID",
      [
        { baseId: 1, "ja-JP": "一" },
        { baseId: 1, "ja-JP": "二" },
      ],
      /duplicate localized override Base ID 1/,
    ],
    ["unsupported locale", [{ baseId: 1, en: "Alpha" }], /unsupported localized override field "en"/],
    ["empty locale", [{ baseId: 1, "ja-JP": "  " }], /localized override ja-JP for Base ID 1 must be a nonempty string/],
    ["no locale fields", [{ baseId: 1 }], /localized override Base ID 1 has no locale names/],
  ];
  for (const [label, localizedOverrides, pattern] of invalidCases) {
    assert.throws(
      () =>
        applyNamePolicy({
          characters: [character("alpha", 1)],
          arcanists: [{ id: 1, name: "甲", nameEng: "Alpha CN" }],
          snapshot: fixtureSnapshot,
          localizedOverrides,
        }),
      (error: unknown) => error instanceof NamePolicyError && pattern.test(error.message),
      label
    );
  }
}

function testUttuNameFallbacks(): void {
  // Admitted supplement metadata fills only empty locales and seeds rarity without unknown-arcanist diagnostics.
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
  const supp = supplementResult.characters[0];
  assert.equal(supp?.names?.["zh-CN"], "既有中文");
  assert.equal(supp?.names?.["en-US"], "Existing English");
  assert.equal(supp?.names?.["ja-JP"], "Manual Japanese");
  assert.equal(supp?.names?.["zh-TW"], "UTTU 繁體");
  assert.equal(supp?.rarity, 4);
  assert.equal(supplementResult.diagnostics.some((e) => e.characterId === "uttu-new"), false);

  // Live UTTU fills only still-empty locales and persists across later offline runs (CMP-10).
  const partialSnapshot: NameSourceSnapshot = {
    ...fixtureSnapshot,
    kornblume: {
      namesByLang: {
        ...fixtureSnapshot.kornblume.namesByLang,
        "zh-CN": { ...fixtureSnapshot.kornblume.namesByLang["zh-CN"], "partial-eta": "己" },
        "en-US": { ...fixtureSnapshot.kornblume.namesByLang["en-US"], "partial-eta": "Partial Eta" },
      },
      arcanists: [...fixtureSnapshot.kornblume.arcanists, { id: 40, name: "Partial Eta", rarity: 5 }],
    },
  };
  const etaArcanists: ArcanistMapEntry[] = [{ id: 9, name: "己", nameEng: "Eta CN" }];
  const livePass = applyNamePolicy({
    characters: [
      character("eta", 9, {
        names: { "zh-CN": "既有己", "en-US": "Existing Eta", "ja-JP": "既存のエータ" },
      }),
    ],
    arcanists: etaArcanists,
    snapshot: partialSnapshot,
    localizedOverrides: [],
    uttuNames: [{ baseId: 9, names: { "ja-JP": "UTTU エータ", "ko-KR": "UTTU 한국" } }],
  });
  assert.equal(livePass.characters[0]?.names?.["zh-CN"], "己");
  assert.equal(livePass.characters[0]?.names?.["en-US"], "Partial Eta");
  assert.equal(livePass.characters[0]?.names?.["ja-JP"], "既存のエータ");
  assert.equal(livePass.characters[0]?.names?.["ko-KR"], "UTTU 한국");

  const offlinePass = applyNamePolicy({
    characters: livePass.characters,
    arcanists: etaArcanists,
    snapshot: partialSnapshot,
    localizedOverrides: [],
  });
  assert.equal(offlinePass.characters[0]?.names?.["ko-KR"], "UTTU 한국");
  assert.equal(offlinePass.characters[0]?.names?.["ja-JP"], "既存のエータ");

  // English fallback & coverage counters reflect final output.
  const fallbackResult = applyNamePolicy({
    characters: [
      character("existing-only", 998, { names: { "en-US": "  Existing Only  " } }),
      character("unnamed", 997),
      character("uttu-only", 996),
    ],
    arcanists: [],
    snapshot: fixtureSnapshot,
    localizedOverrides: [],
    uttuNames: [{ baseId: 996, names: { "en-US": "UTTU Only" } }],
  });
  assert.equal(
    fallbackResult.characters.find((e) => e.id === "existing-only")?.names?.["en-US"],
    "Existing Only"
  );
  assert.equal(
    fallbackResult.characters.find((e) => e.id === "uttu-only")?.names?.["en-US"],
    "UTTU Only"
  );
  assert.equal(fallbackResult.summary.englishFallback, 2);
  assert.equal(fallbackResult.summary.englishMissing, 1);
  assert.equal(fallbackResult.summary.missingByLang["en-US"], 1);
}

async function testRunNameSyncOrchestration(): Promise<void> {
  // 1. Classified NameSourceError falls back to LKG cache.
  let written = false;
  const warnings: string[] = [];
  const lkgResult = await runNameSync({
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
  assert.equal(lkgResult.sourceMode, "last-known-good");
  assert.equal(written, true);
  assert.match(warnings[0] ?? "", /transport\/fixture/);

  // 2. Local NameConfigurationError never falls back to LKG or writes.
  let configCacheRead = false;
  let configWritten = false;
  await assert.rejects(
    () =>
      runNameSync({
        refreshSources: async () => {
          parseJapaneseNameOverrides("not-json", "jp-name-overrides.json");
          return fixtureSnapshot;
        },
        loadCachedSources: async () => {
          configCacheRead = true;
          return fixtureSnapshot;
        },
        cacheExists: () => true,
        loadCharacters: () => [],
        loadArcanists: () => [],
        loadLocalizedOverrides: () => [],
        writeCharacters: () => {
          configWritten = true;
        },
        warn: () => {},
      }),
    (error) => error instanceof NameConfigurationError && error.recoverableWithLkg === false
  );
  assert.equal(configCacheRead, false);
  assert.equal(configWritten, false);

  // 3. Invalid manual override still aborts after LKG selection without writing.
  let invalidOverrideWritten = false;
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
          invalidOverrideWritten = true;
        },
        warn: () => {},
      }),
    (error) =>
      error instanceof NamePolicyError &&
      /localized override Base ID 999 not found in characters/.test(error.message)
  );
  assert.equal(invalidOverrideWritten, false);

  // 4. Live UTTU names & diagnostics flow into policy and warning channel.
  let uttuWrite: Character[] | undefined;
  const uttuWarnings: string[] = [];
  const uttuResult = await runNameSync({
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
    loadArcanists: () => [{ id: 9, name: "己", nameEng: "Eta CN" }],
    loadLocalizedOverrides: () => [],
    writeCharacters: (chars) => {
      uttuWrite = chars;
    },
    warn: (message) => uttuWarnings.push(message),
  });
  assert.equal(uttuResult.sourceMode, "refreshed");
  assert.equal(uttuWrite?.[0]?.names?.["ko-KR"], "UTTU 한국");
  assert.deepEqual(uttuWarnings, ["UTTU profile 3155 has no usable zh name; skipped"]);

  // 5. Classified UTTU failure warns and keeps primary sources refreshed.
  let uttuFailWrite: Character[] | undefined;
  const uttuFailWarnings: string[] = [];
  const uttuFailResult = await runNameSync({
    refreshSources: async () => fixtureSnapshot,
    loadCachedSources: async () => fixtureSnapshot,
    cacheExists: () => false,
    refreshUttuNames: async () => {
      throw new NameSourceError("transport", "UTTU profiles", "offline");
    },
    loadCharacters: () => [character("beta", 2, { names: { "en-US": "Existing Beta" } })],
    loadArcanists: () => [{ id: 2, name: "乙", nameEng: "Beta CN" }],
    loadLocalizedOverrides: () => [],
    writeCharacters: (chars) => {
      uttuFailWrite = chars;
    },
    warn: (message) => uttuFailWarnings.push(message),
  });
  assert.equal(uttuFailResult.sourceMode, "refreshed");
  assert.equal(uttuFailWrite?.[0]?.names?.["en-US"], "Fallback Beta");
  assert.match(uttuFailWarnings[0] ?? "", /UTTU name fallback unavailable/);

  // 6. Unexpected non-NameSourceError UTTU error aborts without writing.
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
    /unexpected UTTU bug/
  );
  assert.equal(unexpectedWrite, false);
}

testGlobalLocalization();
testNamePolicyPrecedenceAndOrdering();
testLocalizedOverrides();
testUttuNameFallbacks();
await testRunNameSyncOrchestration();

console.log("Name policy and sync orchestration checks passed.");
