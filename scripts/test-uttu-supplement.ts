import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createVariantIdentityCatalog } from "../src/domain/variant-identity";
import { finalizeBuildPlan } from "./build-characters";
import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import type { Character } from "./types";
import {
  parseUttuCatalog,
  parseUttuProfileNames,
  parseUttuProfiles,
  UttuParseError,
  type UttuCatalog,
} from "./uttu-parser";
import {
  completeUttuAdmissions,
  fetchUttuCatalogSafely,
  findMissingSupplementImages,
  loadUttuSupplement,
  mergeUttuSupplement,
  parseUttuSupplement,
  planUttuAdmissions,
  saveUttuSupplement,
  UTTU_SOURCE,
  UttuCatchUpConflictError,
  UttuSupplementError,
  type UttuSupplement,
} from "./uttu-supplement";

function htmlWithArray(scriptBody: string): string {
  return `<!doctype html><html><body>
<script>window.decoy=[{not:"a profile"}];</script>
<script>${scriptBody}</script>
</body></html>`;
}

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

function primaryEntry(
  baseId: number,
  variants: Array<{ id: number; des: string; name?: string }>
): ArcanistEntryFull {
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
    defaultVariant:
      skins.find((skin) => skin.type === "default")?.variantId ?? skins[0].variantId,
  };
}

function sampleCatalog(): UttuCatalog {
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
  return parseUttuCatalog(profilesHtml, garmentsHtml);
}

function testUttuParsers(): void {
  // 1. Shape-based catalog extraction ignores decoy scripts & variable names, maps categories, strips N/A.
  const catalog = sampleCatalog();
  assert.deepEqual(catalog.profiles.map((p) => p.baseId), [7400, 9159, 9160]);
  assert.deepEqual(
    catalog.garments.filter((g) => g.baseId === 9160).map((g) => [g.variantId, g.type]),
    [["916001", "default"], ["916002", "insight"], ["916003", "skin"]]
  );
  assert.equal(catalog.garments.find((g) => g.variantId === "916001")?.skinName, null);
  assert.equal(catalog.profiles.find((p) => p.baseId === 9160)?.names["zh-TW"], undefined);
  assert.equal(catalog.incompleteBaseIds.size, 0);

  // Numeric names like "37" normalize to strings across profiles and locales.
  const numericCatalog = parseUttuCatalog(
    htmlWithArray(`const p=[{ID:3066,Name:37,Rarity:6,LocaleName:{en:37,zh:37,tw:37,jp:37,kr:37}}];`),
    htmlWithArray(`const g=[{profile:{ID:3066},garment:{id:306601,name:{en:"Default",zh:"Default"},category:"default",global:!0}}];`)
  );
  assert.equal(numericCatalog.profiles[0]?.nameEng, "37");
  assert.equal(numericCatalog.profiles[0]?.names["ja-JP"], "37");

  // 2. Full profile parsing rejects duplicate IDs and degraded admission metadata.
  assert.throws(
    () =>
      parseUttuProfiles(
        htmlWithArray(`const dup=[
          {ID:9160,Name:"Evelyn",Rarity:6,LocaleName:{en:"Evelyn",zh:"伊芙琳"}},
          {ID:9160,Name:"Evelyn Two",Rarity:6,LocaleName:{en:"Evelyn Two",zh:"伊芙琳二"}}
        ];`)
      ),
    /Duplicate UTTU profile ID: 9160/
  );
  const degradedHtml = htmlWithArray(
    `const p=[{ID:3163,Name:"",Rarity:0,LocaleName:{en:"N/A",zh:"N/A",tw:"N/A",jp:"グリンドゥル",kr:""}}];`
  );
  assert.throws(() => parseUttuProfiles(degradedHtml), /extracted no valid records/);

  // 3. Name-only projection needs only exact Base ID + LocaleName (CMP-02); no cross-language fill.
  const nameCatalog = parseUttuProfileNames(
    htmlWithArray(`const p=[
      {ID:3163,Name:"",Rarity:0,LocaleName:{en:"N/A",zh:"N/A",tw:"N/A",jp:"グリンドゥル",kr:""}},
      {ID:3164,LocaleName:{zh:"中文",tw:"N/A",en:"English",jp:"日本語",kr:"한국어"}},
      {ID:3165,LocaleName:{zh:"N/A"}},
      {ID:3166,Name:"Raw English",LocaleName:{jp:"日本語のみ"}},
      {ID:3066,LocaleName:{en:37,zh:37,tw:37,jp:37,kr:37}}
    ];`)
  );
  assert.deepEqual(nameCatalog.names, [
    {
      baseId: 3066,
      names: { "zh-CN": "37", "zh-TW": "37", "en-US": "37", "ja-JP": "37", "ko-KR": "37" },
    },
    { baseId: 3163, names: { "ja-JP": "グリンドゥル" } },
    {
      baseId: 3164,
      names: { "zh-CN": "中文", "en-US": "English", "ja-JP": "日本語", "ko-KR": "한국어" },
    },
    { baseId: 3166, names: { "ja-JP": "日本語のみ" } },
  ]);
  assert.deepEqual(nameCatalog.diagnostics, ["UTTU profile 3165 has no usable name; skipped"]);

  assert.throws(
    () => parseUttuProfileNames(htmlWithArray(`const p=[{ID:3165,LocaleName:{zh:"N/A"}}];`)),
    (error: unknown) => error instanceof UttuParseError && /extracted no usable names/.test(error.message)
  );
  assert.throws(
    () => parseUttuProfileNames(htmlWithArray("const p = buildProfiles();")),
    (error: unknown) =>
      error instanceof UttuParseError && /No recognizable UTTU profile literal array/.test(error.message)
  );
  assert.throws(
    () =>
      parseUttuProfileNames(
        htmlWithArray(`const dup=[
          {ID:3163,Name:"",Rarity:0,LocaleName:{jp:"グリンドゥル"}},
          {ID:3163,Name:"",Rarity:0,LocaleName:{jp:"別名"}}
        ];`)
      ),
    (error: unknown) => error instanceof UttuParseError && /Duplicate UTTU profile ID: 3163/.test(error.message)
  );
}

async function testSupplementValidationAndIo(): Promise<void> {
  const knownSkin = {
    baseId: 7400,
    variantId: "740099",
    type: "skin",
    skinName: "补给它",
    skinNameEng: "Supplement Skin",
  };
  const validCharacter = {
    baseId: 9160,
    name: "伊芙琳",
    nameEng: "Evelyn",
    names: { "zh-CN": "伊芙琳", "en-US": "Evelyn" },
    rarity: 6,
    defaultVariant: "916001",
    skins: [
      { variantId: "916001", type: "default", skinName: null, skinNameEng: null },
      { variantId: "916002", type: "insight", skinName: "疯谜题", skinNameEng: "Mad as a Riddle" },
    ],
  };

  assert.throws(
    () => supplementFixture({ skins: [knownSkin, { ...knownSkin }] }),
    /Duplicate supplement variant ID/
  );
  assert.throws(
    () =>
      supplementFixture({
        characters: [{ ...validCharacter, name: "N/A", names: { "zh-CN": "N/A", "en-US": "Evelyn" } }],
      }),
    /N\/A/
  );
  assert.throws(
    () => supplementFixture({ characters: [{ ...validCharacter, rarity: 7 }] }),
    /invalid rarity/
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), "r1999-uttu-io-"));
  try {
    const missing = loadUttuSupplement(path.join(dir, "missing.json"));
    assert.deepEqual(missing.characters, []);
    assert.deepEqual(missing.skins, []);

    const corruptFile = path.join(dir, "corrupt.json");
    await writeFile(corruptFile, "{bad json");
    assert.throws(() => loadUttuSupplement(corruptFile), UttuSupplementError);

    const saved = supplementFixture({ characters: [validCharacter], skins: [knownSkin] });
    const file = path.join(dir, "uttu-supplement.json");
    saveUttuSupplement(file, saved);
    assert.deepEqual(loadUttuSupplement(file), saved);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function testMergeAndPrimaryCatchUp(): void {
  const knownSkin = {
    baseId: 7400,
    variantId: "740099",
    type: "skin" as const,
    skinName: "补给它",
    skinNameEng: "Supplement Skin",
  };
  const secondSkin = {
    baseId: 7400,
    variantId: "740098",
    type: "skin" as const,
    skinName: "补给它二",
    skinNameEng: "Supplement Skin Two",
  };
  const primaryBase = primaryEntry(7400, [
    { id: 740001, des: "初始立绘" },
    { id: 740002, des: "进阶立绘", name: "Primary Insight" },
  ]);
  const primaryMapped = [mapCnCharacterMetadata(primaryBase)];
  const current = characterFixture(7400, primaryMapped[0].skins.map((s) => ({ ...s })));

  // 1. Additive supplemental skin appends without changing primary default/types and is build-idempotent.
  const additive = mergeUttuSupplement(primaryMapped, supplementFixture({ skins: [knownSkin] }));
  assert.deepEqual(
    additive.mappedCharacters[0].skins.map((s) => [s.variantId, s.type]),
    [["740001", "default"], ["740002", "insight"], ["740099", "skin"]]
  );
  const localIds = new Set(["740001", "740002", "740099"]);
  const firstBuild = finalizeBuildPlan(
    [cloneCharacterRecord(current)],
    planCnIngestion({
      currentCharacters: [current],
      mappedCharacters: additive.mappedCharacters,
      sourceImageIds: new Set(),
      localImageIds: localIds,
      deprecatedEntries: [],
    })
  );
  assert.equal(firstBuild[0].skins.find((s) => s.variantId === "740099")?.isReleased, false);
  const secondBuild = finalizeBuildPlan(
    firstBuild.map(cloneCharacterRecord),
    planCnIngestion({
      currentCharacters: firstBuild,
      mappedCharacters: additive.mappedCharacters,
      sourceImageIds: new Set(),
      localImageIds: localIds,
      deprecatedEntries: [],
    })
  );
  assert.deepEqual(secondBuild, firstBuild);

  // 2. Primary catch-up returns exact ID to primary (primary metadata wins, no duplicate).
  const caughtUp = mergeUttuSupplement(
    [
      mapCnCharacterMetadata(
        primaryEntry(7400, [
          { id: 740001, des: "初始立绘" },
          { id: 740002, des: "进阶立绘", name: "Primary Insight" },
          { id: 740099, des: "活动立绘", name: "Primary Owns It" },
        ])
      ),
    ],
    supplementFixture({ skins: [knownSkin, secondSkin] })
  );
  assert.deepEqual(caughtUp.returnedToPrimary, ["740099"]);
  assert.deepEqual(caughtUp.supplement.skins.map((s) => s.variantId), ["740098"]);
  assert.equal(
    caughtUp.mappedCharacters[0].skins.find((s) => s.variantId === "740099")?.skinName,
    "Primary Owns It"
  );
  assert.equal(
    caughtUp.mappedCharacters[0].skins.filter((s) => s.variantId === "740099").length,
    1
  );

  // 3. Cross-owner conflict rejects the supplemental skin with a diagnostic.
  const conflict = mergeUttuSupplement(
    [
      mapCnCharacterMetadata(
        primaryEntry(7500, [
          { id: 750001, des: "初始立绘" },
          { id: 740099, des: "活动立绘", name: "Owned Elsewhere" },
        ])
      ),
    ],
    supplementFixture({ skins: [knownSkin] })
  );
  assert.deepEqual(conflict.supplement.skins, []);
  assert.equal(
    conflict.diagnostics.some((m) => /conflicts with primary owner 7500/.test(m)),
    true
  );

  // 4. Partial catch-up of an admitted supplement character (primary catches up default only):
  // retains unmatched insight/skin with original types, stays runtime-valid, and never mutates input.
  const admittedSupplement = supplementFixture({
    characters: [
      {
        baseId: 9160,
        name: "伊芙琳",
        nameEng: "Evelyn",
        names: { "zh-CN": "伊芙琳", "en-US": "Evelyn" },
        rarity: 6,
        defaultVariant: "916001",
        skins: [
          { variantId: "916001", type: "default", skinName: null, skinNameEng: null },
          { variantId: "916002", type: "insight", skinName: "疯谜题", skinNameEng: "Mad as a Riddle" },
          { variantId: "916003", type: "skin", skinName: "新时装", skinNameEng: "A New Skin" },
        ],
      },
    ],
  });
  const snapshotBefore = structuredClone(admittedSupplement);
  const partialCatchUp = mergeUttuSupplement(
    [mapCnCharacterMetadata(primaryEntry(9160, [{ id: 916001, des: "初始立绘" }]))],
    admittedSupplement
  );
  assert.deepEqual(admittedSupplement, snapshotBefore);
  assert.equal(partialCatchUp.supplement.characters.length, 0);
  assert.deepEqual(
    partialCatchUp.supplement.skins.map((s) => [s.variantId, s.type]),
    [["916002", "insight"], ["916003", "skin"]]
  );
  const currentSupp = characterFixture(9160, admittedSupplement.characters[0].skins);
  const retainedBuild = finalizeBuildPlan(
    [cloneCharacterRecord(currentSupp)],
    planCnIngestion({
      currentCharacters: [cloneCharacterRecord(currentSupp)],
      mappedCharacters: partialCatchUp.mappedCharacters,
      sourceImageIds: new Set(),
      localImageIds: new Set(["916001", "916002", "916003"]),
      deprecatedEntries: [],
    })
  ).find((c) => c.baseId === 9160);
  assert.ok(retainedBuild);
  assert.deepEqual(
    retainedBuild.skins.map((s) => [s.variantId, s.type]),
    [["916001", "default"], ["916002", "insight"], ["916003", "skin"]]
  );
  assert.doesNotThrow(() => createVariantIdentityCatalog([retainedBuild]));

  // 5. Competing primary insight ID throws UttuCatchUpConflictError without mutating input.
  assert.throws(
    () =>
      mergeUttuSupplement(
        [
          mapCnCharacterMetadata(
            primaryEntry(9160, [
              { id: 916001, des: "初始立绘" },
              { id: 916009, des: "进阶立绘", name: "Primary Insight" },
            ])
          ),
        ],
        admittedSupplement
      ),
    (error: unknown) => {
      assert.ok(error instanceof UttuCatchUpConflictError);
      assert.equal(error.baseId, 9160);
      assert.equal(error.admittedId, "916002");
      assert.equal(error.primaryId, "916009");
      return true;
    }
  );
  assert.deepEqual(admittedSupplement, snapshotBefore);
}

async function testAdmissionWorkflow(): Promise<void> {
  const catalog = sampleCatalog();
  const primaryMapped = [
    mapCnCharacterMetadata(
      primaryEntry(7400, [
        { id: 740001, des: "初始立绘" },
        { id: 740002, des: "进阶立绘", name: "Primary Insight" },
      ])
    ),
  ];
  const current = [characterFixture(7400, primaryMapped[0].skins.map((s) => ({ ...s })))];

  // Deprecated entries are excluded during admission planning.
  const deprecatedPlan = planUttuAdmissions({
    catalog,
    primaryMapped,
    currentCharacters: current,
    supplement: supplementFixture({}),
    deprecatedEntries: [{ baseId: 9159, variantId: "915901" }],
  });
  assert.deepEqual(deprecatedPlan.newCharacters.map((c) => c.baseId), [9160]);

  // Existing characters receive only type: "skin" variants; unseen default/insight are ignored.
  const plan = planUttuAdmissions({
    catalog,
    primaryMapped,
    currentCharacters: current,
    supplement: supplementFixture({}),
    deprecatedEntries: [],
  });
  assert.deepEqual(plan.knownSkins.map((s) => s.variantId), ["740098", "740099"]);
  assert.deepEqual(plan.newCharacters.map((c) => c.baseId), [9159, 9160]);

  // Incomplete images keep a new character pending (no partial admission) and drop missing skins.
  const partial = completeUttuAdmissions(
    supplementFixture({}),
    plan,
    new Set(["740099", "916001", "915901", "915902"])
  );
  assert.equal(partial.accepted, true);
  assert.deepEqual(partial.supplement.characters.map((c) => c.baseId), [9159]);
  assert.deepEqual(partial.supplement.skins.map((s) => s.variantId), ["740099"]);
  assert.equal(
    partial.pending.some((p) => p.baseId === 9160 && /916002|916003/.test(p.reason)),
    true
  );
  assert.equal(partial.diagnostics.some((m) => /740098/.test(m)), true);

  // Complete images admit everything and mark new bonus skins unreleased.
  const complete = completeUttuAdmissions(
    supplementFixture({}),
    plan,
    new Set(["740098", "740099", "915901", "915902", "916001", "916002", "916003"])
  );
  assert.equal(complete.admittedCharacters, 2);
  assert.equal(complete.admittedSkins, 2);
  const builtNew = planCnIngestion({
    currentCharacters: [],
    mappedCharacters: mergeUttuSupplement([], complete.supplement).mappedCharacters,
    sourceImageIds: new Set(),
    localImageIds: new Set(["915901", "915902", "916001", "916002", "916003"]),
    deprecatedEntries: [],
  }).build.readyNewCharacters.find((c) => c.baseId === 9160);
  assert.equal(builtNew?.name, "伊芙琳");
  assert.equal(builtNew?.rarity, 6);
  assert.equal(builtNew?.skins.find((s) => s.variantId === "916003")?.isReleased, false);

  // Later skin for an admitted supplement character appends to its character record immutably.
  const admitted = complete.supplement;
  const admittedBefore = structuredClone(admitted);
  const laterAppend = completeUttuAdmissions(
    admitted,
    {
      newCharacters: [],
      knownSkins: [
        { baseId: 9160, variantId: "916004", type: "skin", skinName: "Later", skinNameEng: "Later" },
      ],
      diagnostics: [],
      pending: [],
    },
    new Set(["916004"])
  );
  assert.equal(
    laterAppend.supplement.characters
      .find((c) => c.baseId === 9160)
      ?.skins.some((s) => s.variantId === "916004"),
    true
  );
  assert.equal(laterAppend.supplement.skins.some((s) => s.variantId === "916004"), false);
  assert.deepEqual(admitted, admittedBefore);

  // Structurally malformed admission round (multiple insight variants) rejects whole round safely.
  const malformedCatalog = parseUttuCatalog(
    htmlWithArray(`const p=[{ID:9900,Name:"Broken",Rarity:6,LocaleName:{en:"Broken",zh:"损坏"}}];`),
    htmlWithArray(`const g=[
      {profile:{ID:9900},garment:{id:990001,name:{en:"Default",zh:"Default"},category:"default",global:!0}},
      {profile:{ID:9900},garment:{id:990002,name:{en:"Insight 1",zh:"洞悉一"},category:"insight",global:!0}},
      {profile:{ID:9900},garment:{id:990003,name:{en:"Insight 2",zh:"洞悉二"},category:"insight",global:!0}}
    ];`)
  );
  const malformedRound = completeUttuAdmissions(
    admitted,
    planUttuAdmissions({
      catalog: malformedCatalog,
      primaryMapped: [],
      currentCharacters: [],
      supplement: supplementFixture({}),
      deprecatedEntries: [],
    }),
    new Set(["990001", "990002", "990003"])
  );
  assert.equal(malformedRound.accepted, false);
  assert.deepEqual(malformedRound.supplement, admittedBefore);
  assert.deepEqual([malformedRound.admittedCharacters, malformedRound.admittedSkins], [0, 0]);
  assert.match(malformedRound.diagnostics.at(-1) ?? "", /multiple insight variants/);

  // Empty/omitted round preserves prior supplements; missing production images are detected.
  const omitted = completeUttuAdmissions(
    admitted,
    { newCharacters: [], knownSkins: [], diagnostics: [], pending: [] },
    new Set()
  );
  assert.equal(omitted.accepted, true);
  assert.deepEqual(omitted.supplement, admittedBefore);
  assert.deepEqual(
    findMissingSupplementImages(
      admitted,
      new Set(["740099", "915901", "915902", "916001", "916002", "916003"])
    ),
    ["740098"]
  );

  // Outage and empty catalog return null + warning rather than treating UTTU as empty.
  const outage = await fetchUttuCatalogSafely(async () => {
    throw new Error("offline");
  });
  assert.equal(outage.catalog, null);
  assert.match(outage.warning ?? "", /offline/);

  const empty = await fetchUttuCatalogSafely(async () => ({
    profiles: [],
    garments: [],
    diagnostics: [],
    incompleteBaseIds: new Set(),
  }));
  assert.equal(empty.catalog, null);
  assert.match(empty.warning ?? "", /empty catalog/);
}

testUttuParsers();
await testSupplementValidationAndIo();
testMergeAndPrimaryCatchUp();
await testAdmissionWorkflow();

console.log("UTTU parser, supplement merge, and admission checks passed.");
