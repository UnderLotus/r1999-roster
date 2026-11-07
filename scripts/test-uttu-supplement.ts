import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import { finalizeBuildPlan } from "./build-characters";
import {
  completeUttuAdmissions,
  fetchUttuCatalogSafely,
  findMissingSupplementImages,
  loadUttuSupplement,
  mergeUttuSupplement,
  parseUttuSupplement,
  planUttuAdmissions,
  saveUttuSupplement,
  supplementImageUrl,
  UTTU_SOURCE,
  UttuCatchUpConflictError,
  type UttuSupplement,
} from "./uttu-supplement";
import {
  parseUttuCatalog,
  parseUttuProfiles,
  type UttuCatalog,
} from "./uttu-parser";
import { createVariantIdentityCatalog } from "../src/domain/variant-identity";
import type { Character } from "./types";

function htmlWithArray(scriptBody: string): string {
  return `<!doctype html><html><body>
<script>window.decoy=[{not:"a profile"}];</script>
<script>${scriptBody}</script>
</body></html>`;
}

const profilesHtml = htmlWithArray(`
  const renamedProfileData = [
    {ID:9160,Name:"Evelyn",Rarity:6,LocaleName:{en:"Evelyn",zh:"伊芙琳",tw:"N/A",jp:"N/A",kr:"N/A"}},
    {ID:9159,Name:"Perchta",Rarity:6,LocaleName:{en:"Perchta",zh:"佩施塔",tw:"N/A",jp:"N/A",kr:"N/A"}},
    {ID:7400,Name:"Existing",Rarity:5,LocaleName:{en:"Existing",zh:"角色 7400",tw:"角色 7400"}}
  ];
`);
const garmentsHtml = htmlWithArray(`
  const renamedGarmentData = [
    {profile:{ID:9160},garment:{id:916001,name:{en:"Default",zh:"Default"},category:"default",global:!0},garmentIndex:0},
    {profile:{ID:9160},garment:{id:916002,name:{en:"Mad as a Riddle",zh:"疯谜题",tw:"N/A"},category:"insight",global:!0},garmentIndex:1},
    {profile:{ID:9160},garment:{id:916003,name:{en:"A New Skin",zh:"新时装"},category:"advanced",global:!0},garmentIndex:2},
    {profile:{ID:9159},garment:{id:915901,name:{en:"Default",zh:"Default"},category:"default",global:!1},garmentIndex:0},
    {profile:{ID:9159},garment:{id:915902,name:{en:"Once Upon a Runaway",zh:"童话出逃日"},category:"insight",global:!0},garmentIndex:1},
    {profile:{ID:7400},garment:{id:740001,name:{en:"Default",zh:"Default"},category:"default",global:!0},garmentIndex:0},
    {profile:{ID:7400},garment:{id:740002,name:{en:"Existing Insight",zh:"既有洞悉"},category:"insight",global:!0},garmentIndex:1},
    {profile:{ID:7400},garment:{id:740099,name:{en:"Supplement Skin",zh:"补给它"},category:"free",global:!1},garmentIndex:2},
    {profile:{ID:7400},garment:{id:740098,name:{en:"Supplement Skin Two",zh:"补给它二"},category:"advanced",global:!1},garmentIndex:3},
    {profile:{ID:7400},garment:{id:740004,name:{en:"Unseen Default",zh:"未收錄初始"},category:"default",global:!1},garmentIndex:4},
    {profile:{ID:7400},garment:{id:740005,name:{en:"Unseen Insight",zh:"未收錄洞悉"},category:"insight",global:!1},garmentIndex:5}
  ];
`);

const parsedCatalog: UttuCatalog = parseUttuCatalog(profilesHtml, garmentsHtml);
assert.deepEqual(
  parsedCatalog.profiles.map((profile) => profile.baseId),
  [7400, 9159, 9160],
  "profile data shape, not minified variable name or script order, is recognized"
);
assert.deepEqual(
  parsedCatalog.garments
    .filter((garment) => garment.baseId === 9160)
    .map((garment) => [garment.variantId, garment.type]),
  [["916001", "default"], ["916002", "insight"], ["916003", "skin"]],
  "garment categories map to default, insight, and skin Variant types"
);
assert.equal(parsedCatalog.garments.find((garment) => garment.variantId === "916001")?.skinName, null);
assert.equal(parsedCatalog.profiles.find((profile) => profile.baseId === 9160)?.names["zh-TW"], undefined);
assert.equal(parsedCatalog.incompleteBaseIds.size, 0);

const profilesOnly = parseUttuProfiles(profilesHtml);
assert.deepEqual(
  profilesOnly.profiles,
  parsedCatalog.profiles,
  "profiles-only acquisition needs no garments and reuses catalog normalization"
);
assert.throws(
  () =>
    parseUttuProfiles(
      htmlWithArray(`
        const duplicatedProfiles = [
          {ID:9160,Name:"Evelyn",Rarity:6,LocaleName:{en:"Evelyn",zh:"伊芙琳"}},
          {ID:9160,Name:"Evelyn Two",Rarity:6,LocaleName:{en:"Evelyn Two",zh:"伊芙琳二"}}
        ];
      `)
    ),
  /Duplicate UTTU profile ID: 9160/,
  "profiles-only parsing keeps the duplicate-ID guard"
);
console.log("ok: UTTU profiles parse standalone without garment data");

const numericProfiles = htmlWithArray(`
  const numericProfileData = [
    {ID:3066,Name:37,Rarity:6,LocaleName:{en:37,zh:37,tw:37,jp:37,kr:37}}
  ];
`);
const numericGarments = htmlWithArray(`
  const numericGarmentData = [
    {profile:{ID:3066},garment:{id:306601,name:{en:"Default",zh:"Default"},category:"default",global:!0}}
  ];
`);
const numericCatalog = parseUttuCatalog(numericProfiles, numericGarments);
assert.equal(numericCatalog.profiles[0]?.nameEng, "37");
assert.equal(numericCatalog.profiles[0]?.name, "37");
assert.equal(numericCatalog.profiles[0]?.names["ja-JP"], "37");

function supplementFixture(value: {
  characters?: unknown[];
  skins?: unknown[];
}): UttuSupplement {
  return parseUttuSupplement({
    schemaVersion: 1,
    source: UTTU_SOURCE,
    characters: value.characters ?? [],
    skins: value.skins ?? [],
  });
}

const knownSkin = {
  baseId: 7400,
  variantId: "740099",
  type: "skin",
  skinName: "补给它",
  skinNameEng: "Supplement Skin",
};
const secondKnownSkin = {
  baseId: 7400,
  variantId: "740098",
  type: "skin",
  skinName: "补给它二",
  skinNameEng: "Supplement Skin Two",
};
const newSupplementCharacter = {
  baseId: 9160,
  name: "伊芙琳",
  nameEng: "Evelyn",
  names: { "zh-CN": "伊芙琳", "en-US": "Evelyn" },
  rarity: 6,
  defaultVariant: "916001",
  skins: parsedCatalog.garments
    .filter((garment) => garment.baseId === 9160)
    .map((garment) => ({
      variantId: garment.variantId,
      type: garment.type,
      skinName: garment.skinName,
      skinNameEng: garment.skinNameEng,
    })),
};

assert.throws(
  () =>
    supplementFixture({
      skins: [knownSkin, { ...knownSkin, variantId: "740099" }],
    }),
  /Duplicate supplement variant ID/,
  "supplement validation rejects duplicate exact variant IDs"
);
assert.throws(
  () =>
    supplementFixture({
      characters: [
        {
          ...newSupplementCharacter,
          names: { "zh-CN": "N/A", "en-US": "Evelyn" },
          name: "N/A",
        },
      ],
    }),
  /N\/A/,
  "supplement validation rejects N/A names"
);
assert.throws(
  () =>
    supplementFixture({
      characters: [{ ...newSupplementCharacter, rarity: 7 }],
    }),
  /invalid rarity/,
  "supplement validation rejects out-of-range rarity"
);

function primaryEntry(baseId: number, variants: Array<{ id: number; des: string; name?: string }>): ArcanistEntryFull {
  return {
    id: baseId,
    name: `角色 ${baseId}`,
    nameEng: `Character ${baseId}`,
    live2d: variants.map((variant) => ({
      id: variant.id,
      des: variant.des,
      characterSkin: variant.name ?? "",
      characterSkinNameEng: variant.name ?? "",
    })),
  };
}

function characterFixture(baseId: number, skins: Character["skins"]): Character {
  return {
    id: `${baseId}-stable`,
    name: `角色 ${baseId}`,
    baseId,
    releaseOrder: 5,
    enabled: true,
    stage: "live",
    isReleased: true,
    rarity: 5,
    names: { "zh-CN": `角色 ${baseId}`, "en-US": `Character ${baseId}` },
    skins,
    defaultVariant: skins.find((skin) => skin.type === "default")?.variantId ?? skins[0].variantId,
  };
}

const primaryBase = primaryEntry(7400, [
  { id: 740001, des: "初始立绘" },
  { id: 740002, des: "进阶立绘", name: "Primary Insight" },
]);
const primaryMapped = [mapCnCharacterMetadata(primaryBase)];
const current = characterFixture(7400, primaryMapped[0].skins.map((skin) => ({ ...skin })));
const additiveSupplement = supplementFixture({ skins: [knownSkin] });
const additive = mergeUttuSupplement(primaryMapped, additiveSupplement);
assert.deepEqual(
  additive.mappedCharacters[0].skins.map((skin) => [skin.variantId, skin.type]),
  [["740001", "default"], ["740002", "insight"], ["740099", "skin"]],
  "exact-ID supplemental skin is appended without changing primary types/default"
);
assert.equal(additive.mappedCharacters[0].defaultVariant, "740001");

const additiveLocal = new Set(["740001", "740002", "740099"]);
const firstPlan = planCnIngestion({
  currentCharacters: [current],
  mappedCharacters: additive.mappedCharacters,
  sourceImageIds: new Set(),
  localImageIds: additiveLocal,
  deprecatedEntries: [],
});
const firstBuild = finalizeBuildPlan([cloneCharacterRecord(current)], firstPlan);
assert.equal(
  firstBuild[0].skins.find((skin) => skin.variantId === "740099")?.isReleased,
  false,
  "new supplemental skins start unreleased"
);
const secondPlan = planCnIngestion({
  currentCharacters: firstBuild,
  mappedCharacters: additive.mappedCharacters,
  sourceImageIds: new Set(),
  localImageIds: additiveLocal,
  deprecatedEntries: [],
});
const secondBuild = finalizeBuildPlan(firstBuild.map(cloneCharacterRecord), secondPlan);
assert.deepEqual(
  secondBuild,
  firstBuild,
  "supplement skin survives later build reconciliation without reclassification"
);

const caughtUpPrimary = primaryEntry(7400, [
  { id: 740001, des: "初始立绘" },
  { id: 740002, des: "进阶立绘", name: "Primary Insight" },
  { id: 740099, des: "活动立绘", name: "Primary Owns It" },
]);
const catchUp = mergeUttuSupplement(
  [mapCnCharacterMetadata(caughtUpPrimary)],
  supplementFixture({ skins: [knownSkin, secondKnownSkin] })
);
assert.deepEqual(catchUp.returnedToPrimary, ["740099"]);
assert.deepEqual(
  catchUp.supplement.skins.map((skin) => skin.variantId),
  ["740098"],
  "primary catch-up returns matching IDs but keeps other supplements"
);
assert.equal(
  catchUp.mappedCharacters[0].skins.find((skin) => skin.variantId === "740099")?.skinName,
  "Primary Owns It",
  "primary metadata wins after catch-up"
);
assert.equal(
  catchUp.mappedCharacters[0].skins.filter((skin) => skin.variantId === "740099").length,
  1,
  "catch-up does not duplicate the exact variant ID"
);

const conflictPrimary = primaryEntry(7500, [
  { id: 750001, des: "初始立绘" },
  { id: 740099, des: "活动立绘", name: "Owned Elsewhere" },
]);
const conflict = mergeUttuSupplement(
  [mapCnCharacterMetadata(conflictPrimary)],
  supplementFixture({ skins: [knownSkin] })
);
assert.equal(conflict.mappedCharacters.some((entry) => entry.skins.some((skin) => skin.variantId === "740099" && entry.baseId === 7400)), false);
assert.ok(conflict.diagnostics.some((message) => /conflicts with primary owner 7500/.test(message)));
assert.deepEqual(conflict.supplement.skins, [], "owner-conflicting supplement is rejected");

const admissionPlan = planUttuAdmissions({
  catalog: parsedCatalog,
  primaryMapped,
  currentCharacters: [characterFixture(7400, primaryMapped[0].skins.map((skin) => ({ ...skin })))],
  supplement: supplementFixture({}),
  deprecatedEntries: [],
});
assert.deepEqual(
  admissionPlan.knownSkins.map((skin) => skin.variantId),
  ["740098", "740099"],
  "existing characters receive only genuinely new skin variants; unseen default/insight variants are not imported for an existing owner"
);
assert.deepEqual(
  admissionPlan.newCharacters.map((candidate) => candidate.baseId),
  [9159, 9160],
  "new UTTU characters require their explicit default and associated variants"
);
assert.equal(admissionPlan.newCharacters.find((candidate) => candidate.baseId === 9160)?.rarity, 6);
assert.equal(admissionPlan.newCharacters.find((candidate) => candidate.baseId === 9160)?.name, "伊芙琳");

const partialAdmissions = completeUttuAdmissions(
  supplementFixture({}),
  admissionPlan,
  new Set(["740099", "916001", "915901", "915902"])
);
assert.equal(partialAdmissions.accepted, true);
assert.deepEqual(
  partialAdmissions.supplement.characters.map((candidate) => candidate.baseId),
  [9159]
);
assert.deepEqual(
  partialAdmissions.supplement.skins.map((skin) => skin.variantId),
  ["740099"]
);
assert.equal(
  partialAdmissions.pending.some((pending) => pending.baseId === 9160 && /916002|916003/.test(pending.reason)),
  true,
  "an incomplete new character stays pending instead of admitting partial metadata"
);
assert.equal(
  partialAdmissions.diagnostics.some((message) => /740098/.test(message)),
  true,
  "a new skin with no validated image is diagnosed and not admitted"
);

const completeAdmissions = completeUttuAdmissions(
  supplementFixture({}),
  admissionPlan,
  new Set(["740098", "740099", "915901", "915902", "916001", "916002", "916003"])
);
assert.deepEqual(
  completeAdmissions.supplement.characters.map((candidate) => candidate.baseId),
  [9159, 9160]
);
assert.deepEqual(
  completeAdmissions.supplement.skins.map((skin) => skin.variantId),
  ["740098", "740099"]
);
assert.equal(completeAdmissions.admittedCharacters, 2);
assert.equal(completeAdmissions.admittedSkins, 2);
const admittedNewCharacterCatalog = mergeUttuSupplement([], completeAdmissions.supplement);
const admittedNewCharacterPlan = planCnIngestion({
  currentCharacters: [],
  mappedCharacters: admittedNewCharacterCatalog.mappedCharacters,
  sourceImageIds: new Set(),
  localImageIds: new Set(["915901", "915902", "916001", "916002", "916003"]),
  deprecatedEntries: [],
});
const builtNewCharacter = admittedNewCharacterPlan.build.readyNewCharacters.find(
  (candidate) => candidate.baseId === 9160
);
assert.ok(builtNewCharacter);
assert.equal(builtNewCharacter.name, "伊芙琳");
assert.equal(builtNewCharacter.rarity, 6);
assert.equal(
  builtNewCharacter.skins.find((skin) => skin.variantId === "916003")?.isReleased,
  false,
  "new supplemental character bonus skins start unreleased"
);

const admittedSupplement = completeAdmissions.supplement;
const admittedSupplementSnapshot = structuredClone(admittedSupplement);
const admittedCharacter = completeAdmissions.supplement.characters.find(
  (candidate) => candidate.baseId === 9160
);
assert.ok(admittedCharacter);
const currentSupplementCharacter = characterFixture(
  9160,
  admittedCharacter.skins.map((skin) => ({ ...skin }))
);
const partialPrimaryMapped = [
  mapCnCharacterMetadata(
    primaryEntry(9160, [{ id: 916001, des: "初始立绘" }])
  ),
];
const partialCatchUp = mergeUttuSupplement(
  partialPrimaryMapped,
  admittedSupplement
);
assert.deepEqual(
  admittedSupplement,
  admittedSupplementSnapshot,
  "partial catch-up does not mutate the previously admitted supplement"
);
const retainedCharacter = partialCatchUp.mappedCharacters.find(
  (candidate) => candidate.baseId === 9160
);
assert.ok(retainedCharacter);
assert.equal(retainedCharacter.defaultVariant, "916001");
assert.deepEqual(
  retainedCharacter.skins.map((skin) => [skin.variantId, skin.type]),
  [["916001", "default"], ["916002", "insight"], ["916003", "skin"]],
  "unmatched admitted insight and skin variants keep their original types"
);
assert.equal(partialCatchUp.supplement.characters.some((candidate) => candidate.baseId === 9160), false);
assert.deepEqual(
  partialCatchUp.supplement.skins.map((skin) => [skin.variantId, skin.type]),
  [["916002", "insight"], ["916003", "skin"]],
  "retained variants persist in the supplement with original types"
);
const retainedPlan = planCnIngestion({
  currentCharacters: [cloneCharacterRecord(currentSupplementCharacter)],
  mappedCharacters: partialCatchUp.mappedCharacters,
  sourceImageIds: new Set(),
  localImageIds: new Set(["916001", "916002", "916003"]),
  deprecatedEntries: [],
});
const retainedBuild = finalizeBuildPlan(
  [cloneCharacterRecord(currentSupplementCharacter)],
  retainedPlan
).find((candidate) => candidate.baseId === 9160);
assert.ok(retainedBuild);
assert.equal(retainedBuild.defaultVariant, "916001");
assert.deepEqual(
  retainedBuild.skins.map((skin) => [skin.variantId, skin.type]),
  [["916001", "default"], ["916002", "insight"], ["916003", "skin"]],
  "downstream build preserves retained admitted types after partial catch-up"
);
assert.doesNotThrow(
  () => createVariantIdentityCatalog([retainedBuild]),
  "normal default-only partial catch-up remains valid at runtime identity initialization"
);
const exactSupplementPrimary = [
  mapCnCharacterMetadata(
    primaryEntry(9160, [
      { id: 916001, des: "初始立绘" },
      { id: 916002, des: "进阶立绘", name: "Primary Insight" },
    ])
  ),
];
const exactSupplementCatchUp = mergeUttuSupplement(
  exactSupplementPrimary,
  admittedSupplement
);
const exactCaughtMapped = exactSupplementCatchUp.mappedCharacters.find(
  (candidate) => candidate.baseId === 9160
);
assert.ok(exactCaughtMapped);
assert.deepEqual(
  exactCaughtMapped.skins.map((skin) => [skin.variantId, skin.type]),
  [["916001", "default"], ["916002", "insight"], ["916003", "skin"]],
  "exact-ID catch-up deduplicates admitted default/insight and retains ordinary skins"
);
const exactCatchUpCharacter = characterFixture(
  9160,
  exactCaughtMapped.skins.map((skin) => ({ ...skin }))
);
assert.doesNotThrow(
  () => createVariantIdentityCatalog([exactCatchUpCharacter]),
  "exact-ID primary catch-up remains valid at runtime identity initialization"
);

const conflictPrimaryMapped = [
  mapCnCharacterMetadata(
    primaryEntry(9160, [
      { id: 916001, des: "初始立绘" },
      { id: 916009, des: "进阶立绘", name: "Primary Insight" },
    ])
  ),
];
const directConflictSnapshot = structuredClone(admittedSupplement);
assert.throws(
  () => mergeUttuSupplement(conflictPrimaryMapped, admittedSupplement),
  (error: unknown) => {
    assert.ok(error instanceof UttuCatchUpConflictError);
    assert.equal(error.baseId, 9160);
    assert.equal(error.admittedId, "916002");
    assert.equal(error.primaryId, "916009");
    return true;
  },
  "competing admitted insight in the character representation fails closed"
);
assert.deepEqual(
  admittedSupplement,
  directConflictSnapshot,
  "direct catch-up conflict does not mutate the prior supplement"
);

const sequentialSupplement = partialCatchUp.supplement;
const sequentialConflictSnapshot = structuredClone(sequentialSupplement);
assert.throws(
  () => mergeUttuSupplement(conflictPrimaryMapped, sequentialSupplement),
  (error: unknown) => {
    assert.ok(error instanceof UttuCatchUpConflictError);
    assert.equal(error.baseId, 9160);
    assert.equal(error.admittedId, "916002");
    assert.equal(error.primaryId, "916009");
    return true;
  },
  "competing admitted insight in the migrated standalone representation fails closed"
);
assert.deepEqual(
  sequentialSupplement,
  sequentialConflictSnapshot,
  "sequential catch-up conflict does not mutate the prior supplement"
);

const laterSupplementalSkin = {
  baseId: 9160,
  variantId: "916004",
  type: "skin" as const,
  skinName: "Later Skin",
  skinNameEng: "Later Skin",
};
const laterAppend = completeUttuAdmissions(
  admittedSupplement,
  {
    newCharacters: [],
    knownSkins: [laterSupplementalSkin],
    diagnostics: [],
    pending: [],
  },
  new Set([laterSupplementalSkin.variantId])
);
assert.equal(laterAppend.accepted, true);
assert.equal(
  laterAppend.supplement.characters
    .find((candidate) => candidate.baseId === 9160)
    ?.skins.some((skin) => skin.variantId === "916004"),
  true,
  "a later skin for an admitted supplement character appends to its record"
);
assert.equal(
  laterAppend.supplement.skins.some((skin) => skin.variantId === "916004"),
  false,
  "a later skin for an admitted supplement character is not standalone"
);
assert.deepEqual(
  admittedSupplement,
  admittedSupplementSnapshot,
  "later admission appends without mutating previous supplement records"
);

const malformedProfiles = htmlWithArray(`
  const malformedProfiles = [
    {ID:9900,Name:"Broken",Rarity:6,LocaleName:{en:"Broken",zh:"损坏",tw:"N/A",jp:"N/A",kr:"N/A"}}
  ];
`);
const malformedGarments = htmlWithArray(`
  const malformedGarments = [
    {profile:{ID:9900},garment:{id:990001,name:{en:"Default",zh:"Default"},category:"default",global:!0}},
    {profile:{ID:9900},garment:{id:990002,name:{en:"Insight One",zh:"洞悉一"},category:"insight",global:!0}},
    {profile:{ID:9900},garment:{id:990003,name:{en:"Insight Two",zh:"洞悉二"},category:"insight",global:!0}}
  ];
`);
const malformedCatalog = parseUttuCatalog(malformedProfiles, malformedGarments);
const malformedAdmission = planUttuAdmissions({
  catalog: malformedCatalog,
  primaryMapped: [],
  currentCharacters: [],
  supplement: supplementFixture({}),
  deprecatedEntries: [],
});
const recovered = completeUttuAdmissions(
  admittedSupplement,
  malformedAdmission,
  new Set(["990001", "990002", "990003"])
);
assert.equal(recovered.accepted, false);
assert.equal(
  recovered.supplement,
  admittedSupplement,
  "a rejected round returns the previous supplement itself"
);
assert.deepEqual(
  admittedSupplement,
  admittedSupplementSnapshot,
  "failed admission validation leaves the previous supplement immutable"
);
assert.deepEqual(
  [recovered.admittedCharacters, recovered.admittedSkins],
  [0, 0],
  "a rejected round reports no admitted candidates"
);
assert.match(recovered.diagnostics.at(-1) ?? "", /multiple insight variants/);
assert.match(recovered.diagnostics.at(-1) ?? "", /preserving previous supplement/);

const omitted = completeUttuAdmissions(
  admittedSupplement,
  { newCharacters: [], knownSkins: [], diagnostics: [], pending: [] },
  new Set()
);
assert.equal(omitted.accepted, true);
assert.deepEqual(
  omitted.supplement,
  admittedSupplement,
  "a successful catalog omission keeps prior supplements"
);
assert.deepEqual(
  findMissingSupplementImages(admittedSupplement, new Set(["740099", "915901", "915902", "916001", "916002", "916003"])),
  ["740098"],
  "persisted supplement variants require every production image"
);

const saveDirectory = await mkdtemp(path.join(os.tmpdir(), "r1999-uttu-save-"));
try {
  const saveFile = path.join(saveDirectory, "uttu-supplement.json");
  saveUttuSupplement(saveFile, admittedSupplement);
  const previousBytes = JSON.stringify(loadUttuSupplement(saveFile));
  if (process.getuid?.() === 0) {
    console.log("skip: atomic save fault probe cannot deny directory writes as root");
  } else {
    const changedSupplement = supplementFixture({
      skins: [{ ...knownSkin, variantId: "740097", skinName: "Changed", skinNameEng: "Changed" }],
    });
    await chmod(saveDirectory, 0o500);
    try {
      assert.throws(
        () => saveUttuSupplement(saveFile, changedSupplement),
        /EACCES|EPERM|permission denied/i,
        "saving into a write-denied directory fails before replacement"
      );
    } finally {
      await chmod(saveDirectory, 0o700);
    }
    assert.equal(
      JSON.stringify(loadUttuSupplement(saveFile)),
      previousBytes,
      "failed atomic save leaves the prior supplement readable and unchanged"
    );
    assert.deepEqual(
      (await readdir(saveDirectory)).filter((file) => file.includes(".tmp-")),
      [],
      "failed atomic save leaves no sibling temporary file"
    );
  }
} finally {
  await chmod(saveDirectory, 0o700);
  await rm(saveDirectory, { recursive: true, force: true });
}

const outage = await fetchUttuCatalogSafely(async () => {
  throw new Error("offline");
});
assert.equal(outage.catalog, null);
assert.match(outage.warning ?? "", /offline/);
const emptyExtraction = await fetchUttuCatalogSafely(async () => ({
  profiles: [],
  garments: [],
  diagnostics: [],
  incompleteBaseIds: new Set(),
}));
assert.equal(emptyExtraction.catalog, null);
assert.match(emptyExtraction.warning ?? "", /empty catalog/);
assert.equal(supplementImageUrl("916001"), "https://assets.merui.net/headicon_middle/916001.webp");

console.log("UTTU parser, supplement merge and admission checks passed.");
