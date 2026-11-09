import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  parseUttuProfileNames,
  parseUttuProfiles,
  type UttuCatalog,
  UttuParseError,
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

const degradedProfilesHtml = htmlWithArray(`
  const renamedProfileData = [
    {ID:3163,Name:"",Rarity:0,LocaleName:{en:"N/A",zh:"N/A",tw:"N/A",jp:"グリンドゥル",kr:""}}
  ];
`);
const profileNameCatalog = parseUttuProfileNames(htmlWithArray(`
  const renamedProfileData = [
    {ID:3163,Name:"",Rarity:0,LocaleName:{en:"N/A",zh:"N/A",tw:"N/A",jp:"グリンドゥル",kr:""}},
    {ID:3164,LocaleName:{zh:"中文",tw:"N/A",en:"English",jp:"日本語",kr:"한국어"}},
    {ID:3165,LocaleName:{zh:"N/A"}},
    {ID:3166,Name:"Raw English",LocaleName:{jp:"日本語のみ"}},
    {ID:3066,LocaleName:{en:37,zh:37,tw:37,jp:37,kr:37}}
  ];
`));
assert.deepEqual(
  profileNameCatalog.names,
  [
    {
      baseId: 3066,
      names: {
        "zh-CN": "37",
        "zh-TW": "37",
        "en-US": "37",
        "ja-JP": "37",
        "ko-KR": "37",
      },
    },
    { baseId: 3163, names: { "ja-JP": "グリンドゥル" } },
    {
      baseId: 3164,
      names: {
        "zh-CN": "中文",
        "en-US": "English",
        "ja-JP": "日本語",
        "ko-KR": "한국어",
      },
    },
    { baseId: 3166, names: { "ja-JP": "日本語のみ" } },
  ],
  "name-only rows need only an exact Base ID and LocaleName; N/A stays absent and raw Name is not English"
);
assert.deepEqual(
  profileNameCatalog.diagnostics,
  ["UTTU profile 3165 has no usable name; skipped"],
  "a row without a supplied locale is diagnosed instead of inventing a name"
);
assert.throws(
  () => parseUttuProfiles(degradedProfilesHtml),
  /extracted no valid records/,
  "full profile admission still requires Name, Rarity, and a usable CN name"
);
assert.throws(
  () =>
    parseUttuProfileNames(htmlWithArray(`
      const renamedProfileData = [{ID:3165,LocaleName:{zh:"N/A"}}];
    `)),
  (error: unknown) =>
    error instanceof UttuParseError && /extracted no usable names/.test(error.message),
  "a page with zero usable name rows is a typed parse failure"
);
assert.throws(
  () =>
    parseUttuProfileNames(htmlWithArray("const renamedProfileData = buildProfiles();")),
  (error: unknown) =>
    error instanceof UttuParseError && /No recognizable UTTU profile literal array/.test(error.message),
  "a non-literal profile page is a typed parse failure"
);
assert.throws(
  () =>
    parseUttuProfileNames(
      htmlWithArray(`
        const duplicatedProfiles = [
          {ID:3163,Name:"",Rarity:0,LocaleName:{jp:"グリンドゥル"}},
          {ID:3163,Name:"",Rarity:0,LocaleName:{jp:"別名"}}
        ];
      `)
    ),
  (error: unknown) =>
    error instanceof UttuParseError && /Duplicate UTTU profile ID: 3163/.test(error.message),
  "duplicate IDs are rejected before degraded metadata can skip a row"
);
console.log("ok: UTTU names parse without admission metadata and keep duplicate guards");

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
assert.deepEqual(
  recovered.supplement,
  admittedSupplementSnapshot,
  "a rejected round preserves the previous supplement content"
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
  assert.deepEqual(
    loadUttuSupplement(saveFile),
    admittedSupplement,
    "saved supplement round-trips the admitted records"
  );
} finally {
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
