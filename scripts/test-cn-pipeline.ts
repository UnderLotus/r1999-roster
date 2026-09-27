import assert from "node:assert/strict";

import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import {
  applyBuildPlan,
  finalizeBuildPlan,
} from "./build-characters";
import {
  applyReleaseStatuses,
  type GlobalReleaseSnapshot,
  type ReleaseOverrides,
} from "./release-status";
import type { Character } from "./types";

const eightDigitVariantIds = ["30880001", "30660001"];

function fixtureCharacter(
  entry: ArcanistEntryFull,
  skins = mapCnCharacterMetadata(entry).skins.map((skin) => ({ ...skin }))
): Character {
  return {
    id: `${entry.id}01`,
    name: entry.name,
    baseId: entry.id,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: false,
    skins,
    defaultVariant: `${entry.id}01`,
  };
}

function skinById(
  characters: readonly Character[],
  variantId: string
): Character["skins"][number] {
  const skin = characters
    .flatMap((character) => character.skins)
    .find((candidate) => candidate.variantId === variantId);
  assert.ok(skin, `built skins contain ${variantId}`);
  return skin;
}

// Minimal OLD roster plus a fresh mapping. The 8-digit variants are absent from
// the old records and must be staged before build reconciliation applies them.
const oldEntries: ArcanistEntryFull[] = [
  {
    id: 3088,
    name: "Semmelweis",
    nameEng: "Semmelweis",
    live2d: [
      { id: 308801, des: "初始皮肤", characterSkin: "", characterSkinNameEng: "" },
      { id: 308802, des: "进阶皮肤", characterSkin: "Mirror", characterSkinNameEng: "The Mirror" },
      { id: 308803, des: "叩门礼仪", characterSkin: "A Knock on the Door", characterSkinNameEng: "A Knock on the Door" },
      { id: 308804, des: "心之盈亏", characterSkin: "The Wax and Wane of the Heart", characterSkinNameEng: "The Wax and Wane of the Heart" },
    ],
  },
  {
    id: 3066,
    name: "37",
    nameEng: "Thirty-seven",
    live2d: [
      { id: 306601, des: "初始皮肤", characterSkin: "", characterSkinNameEng: "" },
      { id: 306602, des: "进阶皮肤", characterSkin: "A Prime Number", characterSkinNameEng: "A Prime Number" },
      { id: 306603, des: "快乐的捕鸟人", characterSkin: "Happy Bird Catcher", characterSkinNameEng: "Happy Bird Catcher" },
      { id: 306604, des: "泉眼深处", characterSkin: "Down in the Grotto", characterSkinNameEng: "Down in the Grotto" },
      { id: 306605, des: "完美的流体", characterSkin: "Perfect Fluid", characterSkinNameEng: "Perfect Fluid" },
    ],
  },
];
const freshEntries: ArcanistEntryFull[] = [
  {
    ...oldEntries[0],
    live2d: [
      ...oldEntries[0].live2d,
      { id: 30880001, des: "活动皮肤", characterSkin: "Fresh", characterSkinNameEng: "Fresh" },
    ],
  },
  {
    ...oldEntries[1],
    live2d: [
      ...oldEntries[1].live2d,
      { id: 30660001, des: "活动皮肤", characterSkin: "Fresh", characterSkinNameEng: "Fresh" },
    ],
  },
];

const oldCharacters = oldEntries.map((entry) => fixtureCharacter(entry));
assert.equal(
  oldCharacters.some((character) =>
    character.skins.some((skin) => eightDigitVariantIds.includes(skin.variantId))
  ),
  false,
  "OLD character fixtures do not already contain the fresh eight-digit skins"
);
const stagingPlan = planCnIngestion({
  currentCharacters: oldCharacters,
  mappedCharacters: freshEntries.map(mapCnCharacterMetadata),
  sourceImageIds: new Set(
    freshEntries.flatMap((entry) =>
      mapCnCharacterMetadata(entry).skins.map((skin) => skin.variantId)
    )
  ),
  localImageIds: new Set(),
  deprecatedEntries: [],
});
const stagedVariantIds = new Set(stagingPlan.stagedVariantIds);
const expectedStagedVariantIds = new Set([
  ...oldCharacters.flatMap((character) => character.skins.map((skin) => skin.variantId)),
  ...eightDigitVariantIds,
]);
assert.deepEqual(
  [...stagedVariantIds].sort(),
  [...expectedStagedVariantIds].sort(),
  "production staging includes fresh-map skins for existing OLD characters"
);
const appliedOldCharacters = oldCharacters.map(cloneCharacterRecord);
applyBuildPlan(appliedOldCharacters, stagingPlan);
for (const variantId of eightDigitVariantIds) {
  assert.equal(
    skinById(appliedOldCharacters, variantId).type,
    "skin",
    `${variantId} is applied as a skin`
  );
}
assert.deepEqual(
  appliedOldCharacters.map((character) => character.id),
  oldCharacters.map((character) => character.id),
  "build application preserves existing Character IDs"
);

// The same mapping conversion classifies explicit defaults, insights, and
// opaque 8-digit skins without relying on digit prefixes.
const builtCharacters = freshEntries.map((entry) => fixtureCharacter(entry));
assert.equal(skinById(builtCharacters, "308801").type, "default");
assert.equal(skinById(builtCharacters, "308802").type, "insight");
assert.equal(skinById(builtCharacters, "306601").type, "default");
assert.equal(skinById(builtCharacters, "306602").type, "insight");
assert.equal(skinById(builtCharacters, "30880001").type, "skin");
assert.equal(skinById(builtCharacters, "30660001").type, "skin");

// Producer regression: explicit CN mapping metadata may designate a default
// that is not {baseId}01. New records use it, while existing Character IDs
// remain stable when their mapped variants/default are reconciled.
const syntheticMapping: ArcanistEntryFull = {
  id: 4900,
  name: "Synthetic",
  nameEng: "Synthetic",
  live2d: [
    { id: 490099, des: "初始立绘", characterSkin: "", characterSkinNameEng: "" },
    { id: 490098, des: "进阶立绘", characterSkin: "", characterSkinNameEng: "" },
    { id: 490097, des: "活动立绘", characterSkin: "", characterSkinNameEng: "" },
  ],
};
const syntheticMapped = mapCnCharacterMetadata(syntheticMapping);
assert.equal(syntheticMapped.defaultVariant, "490099");
assert.notEqual(syntheticMapped.defaultVariant, "490001");
const syntheticPlan = planCnIngestion({
  currentCharacters: [],
  mappedCharacters: [syntheticMapped],
  sourceImageIds: new Set(["490097", "490098", "490099"]),
  localImageIds: new Set(["490099"]),
  deprecatedEntries: [],
});
const syntheticNew = syntheticPlan.sync.readyNewCharacters[0];
assert.ok(syntheticNew);
assert.equal(syntheticNew.id, "490099");
assert.equal(syntheticNew.defaultVariant, "490099");
const syntheticExisting: Character = {
  id: "legacy-synthetic-id",
  name: "Synthetic",
  baseId: 4900,
  releaseOrder: 1,
  enabled: true,
  stage: "live",
  isReleased: true,
  skins: [
    { variantId: "490001", type: "default", skinName: null, skinNameEng: null, isReleased: true },
  ],
  defaultVariant: "490001",
};
const syntheticExistingPlan = planCnIngestion({
  currentCharacters: [syntheticExisting],
  mappedCharacters: [syntheticMapped],
  sourceImageIds: new Set(["490097", "490098", "490099"]),
  localImageIds: new Set(["490099"]),
  deprecatedEntries: [],
});
const reconciledSynthetic = syntheticExistingPlan.existingCharacterReconciliations[0]?.after;
assert.ok(reconciledSynthetic);
assert.equal(syntheticExisting.id, "legacy-synthetic-id");
assert.equal(reconciledSynthetic.defaultVariant, "490099");
assert.deepEqual(
  reconciledSynthetic.skins.map((skin) => [skin.variantId, skin.type]),
  [["490099", "default"], ["490098", "insight"], ["490097", "skin"]]
);

const releaseSnapshot: GlobalReleaseSnapshot = {
  characters: freshEntries.map((entry) => ({ id: entry.id, isOnline: 1 })),
  // Include the IDs in Global as well: local false overrides must still win.
  skins: eightDigitVariantIds.map((variantId) => ({ id: Number(variantId) })),
};
const falseOverrides: ReleaseOverrides = {
  characters: [],
  skins: eightDigitVariantIds.map((variantId) => ({ variantId, isReleased: false })),
};
const firstRelease = applyReleaseStatuses(builtCharacters, releaseSnapshot, falseOverrides);
assert.ok(firstRelease.skinChanges >= 2, "release reconciliation visits both eight-digit skins");
for (const variantId of eightDigitVariantIds) {
  assert.equal(skinById(builtCharacters, variantId).isReleased, false);
}
const secondRelease = applyReleaseStatuses(builtCharacters, releaseSnapshot, falseOverrides);
assert.equal(secondRelease.skinChanges, 0, "false release overrides are idempotent");
for (const variantId of eightDigitVariantIds) {
  assert.equal(skinById(builtCharacters, variantId).isReleased, false);
}

function orderCharacter(baseId: number, overrides: Partial<Character> = {}): Character {
  return {
    id: `${baseId}01`,
    name: `Order ${baseId}`,
    baseId,
    releaseOrder: 99,
    enabled: true,
    stage: "live",
    isReleased: true,
    skins: [
      { variantId: `${baseId}01`, type: "default", skinName: null, skinNameEng: null },
    ],
    defaultVariant: `${baseId}01`,
    ...overrides,
  };
}
const orderProbe = [
  orderCharacter(200),
  orderCharacter(100),
  orderCharacter(400, { rarity: 5, _kbId: 4 }),
  orderCharacter(300, { rarity: 6, _kbId: 3 }),
  orderCharacter(600, { source: { pageUrl: "https://example.test/600" }, _wikiIndex: 2 }),
  orderCharacter(500, { source: { pageUrl: "https://example.test/500" }, _wikiIndex: 1 }),
];
const finalizedOrderProbe = finalizeBuildPlan(
  orderProbe,
  planCnIngestion({
    currentCharacters: orderProbe,
    mappedCharacters: [],
    sourceImageIds: new Set(),
    localImageIds: new Set(),
    deprecatedEntries: [],
  })
);
assert.deepEqual(finalizedOrderProbe.map((character) => character.baseId), [100, 200, 300, 400, 500, 600]);
assert.deepEqual(finalizedOrderProbe.map((character) => character.releaseOrder), [1, 2, 3, 4, 5, 6]);
const rerunOrderProbe = finalizeBuildPlan(
  finalizedOrderProbe.map(cloneCharacterRecord),
  planCnIngestion({
    currentCharacters: finalizedOrderProbe,
    mappedCharacters: [],
    sourceImageIds: new Set(),
    localImageIds: new Set(),
    deprecatedEntries: [],
  })
);
assert.deepEqual(rerunOrderProbe, finalizedOrderProbe, "finalized order is idempotent");

console.log("CN 4.0 pipeline regression checks passed.");
