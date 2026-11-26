import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

import { applyBuildPlan, finalizeBuildPlan } from "./build-characters";
import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import { recalculateReleaseOrder } from "./recalculate-order";
import {
  applySyncPlan,
  collectMappingLagCandidates,
  reportSyncDiagnostics,
} from "./sync-assets";
import type { Character } from "./types";
import { validateImageParity } from "./webp-converter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");

function entry(
  baseId: number,
  variants: Array<{ id: number; des?: string; name?: string }>
): ArcanistEntryFull {
  return {
    id: baseId,
    name: `角色 ${baseId}`,
    nameEng: `Character ${baseId}`,
    live2d: variants.map((variant) => ({
      id: variant.id,
      des: variant.des ?? "",
      characterSkin: variant.name ?? "",
      characterSkinNameEng: variant.name ?? "",
    })),
  };
}

function character(
  baseId: number,
  skins: Character["skins"],
  overrides: Partial<Character> = {}
): Character {
  return {
    id: `${baseId}-stable-id`,
    name: `角色 ${baseId}`,
    baseId,
    releaseOrder: 7,
    enabled: true,
    stage: "live",
    isReleased: true,
    skins,
    defaultVariant: skins[0].variantId,
    names: { "en-US": `Character ${baseId}` },
    source: { pageUrl: `https://example.test/${baseId}` },
    ...overrides,
  };
}

function skinById(
  characters: readonly Character[],
  variantId: string
): Character["skins"][number] {
  const skin = characters
    .flatMap((candidate) => candidate.skins)
    .find((candidate) => candidate.variantId === variantId);
  assert.ok(skin, `skins contain ${variantId}`);
  return skin;
}

/* ---------- Pure CN mapping, ingestion planning, and release ordering ---------- */

function testEightDigitAndExplicitDefaultMapping(): void {
  // 8-digit portrait skins (30880001, 30660001) end in "01" but belong to the
  // character as type "skin", must be staged for existing records, and must not
  // overwrite stable Character IDs.
  const oldEntries: ArcanistEntryFull[] = [
    entry(3088, [
      { id: 308801, des: "初始皮肤" },
      { id: 308802, des: "进阶皮肤", name: "The Mirror" },
    ]),
    entry(3066, [
      { id: 306601, des: "初始皮肤" },
      { id: 306602, des: "进阶皮肤", name: "A Prime Number" },
    ]),
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
        { id: 30660001, des: "", characterSkin: "Fresh", characterSkinNameEng: "Fresh" },
      ],
    },
  ];

  const oldCharacters = oldEntries.map((item) =>
    character(item.id, mapCnCharacterMetadata(item).skins.map((skin) => ({ ...skin })), {
      id: `${item.id}01`,
    })
  );
  const freshMapped = freshEntries.map(mapCnCharacterMetadata);
  const stagingPlan = planCnIngestion({
    currentCharacters: oldCharacters,
    mappedCharacters: freshMapped,
    sourceImageIds: new Set(
      freshMapped.flatMap((mapped) => mapped.skins.map((skin) => skin.variantId))
    ),
    localImageIds: new Set(),
    deprecatedEntries: [],
  });
  assert.deepEqual(
    [...stagingPlan.stagedVariantIds].sort(),
    ["30660001", "306601", "306602", "30880001", "308801", "308802"],
    "staging includes fresh 8-digit skins for existing characters"
  );

  const applied = oldCharacters.map(cloneCharacterRecord);
  applyBuildPlan(applied, stagingPlan);
  assert.equal(skinById(applied, "308801").type, "default");
  assert.equal(skinById(applied, "308802").type, "insight");
  assert.equal(skinById(applied, "30880001").type, "skin");
  assert.equal(skinById(applied, "30660001").type, "skin");
  assert.deepEqual(
    applied.map((candidate) => candidate.id),
    oldCharacters.map((candidate) => candidate.id),
    "build application preserves existing Character IDs"
  );

  // Explicit CN metadata may designate a default that is not {baseId}01.
  const nonZeroOneMapping = mapCnCharacterMetadata(
    entry(4900, [
      { id: 490099, des: "初始立绘" },
      { id: 490098, des: "进阶立绘" },
      { id: 490097, des: "活动立绘" },
    ])
  );
  assert.equal(nonZeroOneMapping.defaultVariant, "490099");

  const newPlan = planCnIngestion({
    currentCharacters: [],
    mappedCharacters: [nonZeroOneMapping],
    sourceImageIds: new Set(["490097", "490098", "490099"]),
    localImageIds: new Set(["490099"]),
    deprecatedEntries: [],
  });
  assert.equal(newPlan.sync.readyNewCharacters[0]?.id, "490099");
  assert.equal(newPlan.sync.readyNewCharacters[0]?.defaultVariant, "490099");

  const legacyExisting = character(
    4900,
    [{ variantId: "490001", type: "default", skinName: null, skinNameEng: null, isReleased: true }],
    { id: "legacy-synthetic-id" }
  );
  const existingPlan = planCnIngestion({
    currentCharacters: [legacyExisting],
    mappedCharacters: [nonZeroOneMapping],
    sourceImageIds: new Set(["490097", "490098", "490099"]),
    localImageIds: new Set(["490099"]),
    deprecatedEntries: [],
  });
  const reconciled = existingPlan.existingCharacterReconciliations[0]?.after;
  assert.ok(reconciled);
  assert.equal(reconciled.id, "legacy-synthetic-id");
  assert.equal(reconciled.defaultVariant, "490099");
  assert.deepEqual(
    reconciled.skins.map((skin) => [skin.variantId, skin.type]),
    [["490099", "default"], ["490098", "insight"], ["490097", "skin"]]
  );

  // Missing or duplicate default variants fail loudly.
  assert.throws(
    () => mapCnCharacterMetadata(entry(4901, [{ id: 490103, des: "活动立绘" }])),
    /has no default variant/
  );
  assert.throws(
    () =>
      mapCnCharacterMetadata(
        entry(4902, [
          { id: 490201, des: "初始立绘" },
          { id: 490299, des: "初始立绘" },
        ])
      ),
    /Multiple default variants/
  );
}

function testCnIngestionPlanningAndReconciliation(): void {
  const existing = character(
    7400,
    [
      { variantId: "740001", type: "default", skinName: null, skinNameEng: null, isReleased: true },
      { variantId: "740003", type: "skin", skinName: "Existing omitted skin", skinNameEng: "Existing omitted skin" },
      { variantId: "740006", type: "skin", skinName: "Existing false skin", skinNameEng: "Existing false skin", isReleased: false },
    ],
    { id: "existing-character-id" }
  );
  const mappedCharacters = [
    entry(3029, [{ id: 302901, des: "初始立绘" }]),
    entry(7300, [{ id: 730001, des: "初始立绘" }]),
    entry(7100, [
      { id: 710001, des: "初始立绘" },
      { id: 710002, des: "进阶立绘" },
    ]),
    entry(7400, [
      { id: 740001, des: "初始立绘" },
      { id: 740003, des: "活动立绘", name: "Existing omitted skin" },
      { id: 740006, des: "活动立绘", name: "Existing false skin" },
      { id: 740005, des: "活动立绘", name: "Fresh skin" },
    ]),
    entry(7200, [
      { id: 720001, des: "初始立绘" },
      { id: 720003, des: "活动立绘" },
    ]),
  ].map(mapCnCharacterMetadata);

  const sourceImageIds = new Set([
    "740001", "740003", "740006", "740005", "710001", "710002", "720001",
  ]);
  const localImageIds = new Set([
    "740001", "740003", "740006", "740005", "710001", "720001",
  ]);
  const currentBefore = structuredClone([existing]);

  const plan = planCnIngestion({
    currentCharacters: [existing],
    mappedCharacters,
    sourceImageIds,
    localImageIds,
    deprecatedEntries: [{ baseId: 3029, variantId: "302901" }],
  });

  assert.deepEqual([existing], currentBefore, "planning does not mutate input roster");
  assert.equal(plan.existingCharacterReconciliations.length, 1);

  const after = plan.existingCharacterReconciliations[0].after;
  assert.equal(after.id, "existing-character-id");
  assert.equal(after.defaultVariant, "740001");
  assert.equal(after.source?.pageUrl, existing.source?.pageUrl);
  assert.equal(skinById([after], "740001").isReleased, true);
  assert.equal(
    Object.prototype.hasOwnProperty.call(skinById([after], "740003"), "isReleased"),
    false,
    "existing omitted release marker remains omitted"
  );
  assert.equal(skinById([after], "740006").isReleased, false);
  assert.equal(
    skinById([after], "740005").isReleased,
    false,
    "genuinely new mapped skin receives provisional false"
  );

  // Sync requires all source PNGs; standalone build checks only mapped default local WebP.
  assert.deepEqual(plan.sync.readyNewCharacters.map((c) => c.baseId), [7100]);
  assert.deepEqual(plan.sync.pendingNewCharacters.map((c) => c.baseId), [7200, 7300]);
  assert.deepEqual(plan.build.readyNewCharacters.map((c) => c.baseId), [7100, 7200]);
  assert.deepEqual(plan.build.pendingNewCharacters.map((c) => c.baseId), [7300]);
  assert.deepEqual(plan.deprecatedSkips.map((c) => c.baseId), [3029]);
  assert.equal(plan.requiredVariantIds.includes("720003"), true);
  assert.equal(plan.stagedVariantIds.includes("720003"), false);
  assert.equal(plan.requiredVariantIds.includes("302901"), false);

  // applySyncPlan vs applyBuildPlan
  const syncRoster = [cloneCharacterRecord(existing)];
  applySyncPlan(syncRoster, plan);
  assert.equal(syncRoster.length, 2);
  assert.equal(syncRoster.some((c) => c.baseId === 7200), false);

  const buildRoster = [cloneCharacterRecord(existing)];
  applyBuildPlan(buildRoster, plan);
  assert.equal(buildRoster.length, 3);
  assert.equal(buildRoster.find((c) => c.baseId === 7400)?.skins.length, 4);
  assert.equal(buildRoster.some((c) => c.baseId === 7200), true);
  assert.equal(buildRoster.some((c) => c.baseId === 7300), false);

  // Full-output idempotency across two finalizeBuildPlan passes
  const firstFinalized = finalizeBuildPlan([cloneCharacterRecord(existing)], plan);
  const secondPlan = planCnIngestion({
    currentCharacters: firstFinalized,
    mappedCharacters,
    sourceImageIds,
    localImageIds,
    deprecatedEntries: [{ baseId: 3029, variantId: "302901" }],
  });
  const secondFinalized = finalizeBuildPlan(
    firstFinalized.map(cloneCharacterRecord),
    secondPlan
  );
  assert.deepEqual(secondFinalized, firstFinalized, "build finalization is idempotent");

  // Non-blocking mapping-lag heuristic
  const warningCandidates = collectMappingLagCandidates(
    new Set(["315501", "410101", "610301"]),
    new Set(),
    new Set()
  );
  assert.deepEqual(warningCandidates.map((c) => c.variantId), ["315501"]);
  const warningPlan = planCnIngestion({
    currentCharacters: [],
    mappedCharacters: [],
    sourceImageIds: new Set(["315501", "410101", "610301"]),
    localImageIds: new Set(),
    deprecatedEntries: [],
    diagnosticCandidates: warningCandidates,
  });
  assert.deepEqual(warningPlan.diagnostics.map((d) => d.id), ["cn-mapping-lag:315501"]);
  assert.equal(warningPlan.diagnostics[0]?.blocking, false);
  assert.deepEqual(warningPlan.sync.pendingNewCharacters, []);
  const warnings: string[] = [];
  reportSyncDiagnostics(warningPlan.diagnostics, (message) => warnings.push(message));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /315501/);
  const warningRoster: Character[] = [];
  applySyncPlan(warningRoster, warningPlan);
  assert.deepEqual(warningRoster, [], "mapping lag never enters roster or pending");
}

function testReleaseOrderThreeTiersAndIdempotency(): void {
  const orderChar = (baseId: number, overrides: Partial<Character> = {}): Character =>
    character(
      baseId,
      [{ variantId: `${baseId}01`, type: "default", skinName: null, skinNameEng: null }],
      { id: `${baseId}01`, releaseOrder: 99, source: undefined, ...overrides }
    );

  // Tier 1 (CN Asset: no pageUrl, no rarity) -> baseId asc
  // Tier 2 (Kornblume: no pageUrl, has rarity) -> rarity desc, _kbId asc
  // Tier 3 (Wiki: has pageUrl) -> _wikiIndex asc, then legacy without _wikiIndex by releaseOrder
  const probe = [
    orderChar(200),
    orderChar(100),
    orderChar(400, { rarity: 5, _kbId: 4 }),
    orderChar(300, { rarity: 6, _kbId: 3 }),
    orderChar(700, { source: { pageUrl: "https://example.test/700" }, releaseOrder: 20 }),
    orderChar(800, { source: { pageUrl: "https://example.test/800" }, releaseOrder: 1 }),
    orderChar(600, { source: { pageUrl: "https://example.test/600" }, _wikiIndex: 2 }),
    orderChar(500, { source: { pageUrl: "https://example.test/500" }, _wikiIndex: 1 }),
  ];

  const ordered = recalculateReleaseOrder(probe.map(cloneCharacterRecord));
  assert.deepEqual(
    ordered.map((c) => c.baseId),
    [100, 200, 300, 400, 500, 600, 800, 700],
    "three-tier order places Asset, Kornblume, indexed Wiki, then legacy Wiki"
  );
  assert.deepEqual(
    ordered.map((c) => c.releaseOrder),
    [1, 2, 3, 4, 5, 6, 7, 8]
  );

  // Rerun without _wikiIndex/_kbId via finalizeBuildPlan stays idempotent
  const cleaned = ordered.map((c) => {
    const copy = cloneCharacterRecord(c);
    delete copy._kbId;
    delete copy._wikiIndex;
    return copy;
  });
  const emptyPlan = planCnIngestion({
    currentCharacters: cleaned,
    mappedCharacters: [],
    sourceImageIds: new Set(),
    localImageIds: new Set(),
    deprecatedEntries: [],
  });
  const rerun = finalizeBuildPlan(cleaned.map(cloneCharacterRecord), emptyPlan);
  assert.deepEqual(rerun, cleaned, "finalized three-tier order is idempotent");
}

/* ---------- End-to-end CLI fixture tests (sync-assets & build-characters) ---------- */

async function writeFixturePng(file: string): Promise<void> {
  await sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toFile(file);
}

async function writeFixtureWebp(
  file: string,
  background: { r: number; g: number; b: number }
): Promise<void> {
  await sharp({
    create: { width: 1, height: 1, channels: 4, background: { ...background, alpha: 1 } },
  })
    .webp({ lossless: true })
    .toFile(file);
}

async function createCliFixture(): Promise<string> {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "r1999-cn-cli-"));
  await mkdir(path.join(fixtureRoot, "scripts", "data"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "src", "data"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "src", "domain"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "public", "assets", "characters", "avatars"), {
    recursive: true,
  });
  await mkdir(path.join(fixtureRoot, "public", "assets"), { recursive: true });

  // Copy all non-test script modules dynamically so new script imports never break fixtures.
  const scriptFiles = (await readdir(path.join(ROOT, "scripts"))).filter(
    (file) => file.endsWith(".ts") && !file.startsWith("test-")
  );
  await Promise.all(
    scriptFiles.map((file) =>
      cp(path.join(ROOT, "scripts", file), path.join(fixtureRoot, "scripts", file))
    )
  );
  await cp(
    path.join(ROOT, "src", "domain", "variant-identity.ts"),
    path.join(fixtureRoot, "src", "domain", "variant-identity.ts")
  );
  await symlink(path.join(ROOT, "node_modules"), path.join(fixtureRoot, "node_modules"), "dir");
  await writeFixtureWebp(
    path.join(fixtureRoot, "public", "assets", "vertin_question.webp"),
    { r: 0, g: 128, b: 255 }
  );
  await writeFile(path.join(fixtureRoot, "scripts", "data", "deprecated-characters.json"), "[]\n");
  await writeFile(path.join(fixtureRoot, "scripts", "data", "pending-characters.json"), "[]\n");
  await writeFile(path.join(fixtureRoot, "scripts", "data", "avatar-hash-cache.json"), "{}\n");
  return fixtureRoot;
}

async function setupSyncAssetFixture(options: {
  upstreamMap: ArcanistEntryFull[];
  currentCharacters: Character[];
  sourcePngIds: string[];
  curlScript: string;
}): Promise<{ fixtureRoot: string; assetRepo: string; sourceDir: string; fakeBin: string }> {
  const fixtureRoot = await createCliFixture();
  const assetRepo = path.join(fixtureRoot, "asset-sync");
  const sourceDir = path.join(assetRepo, "singlebg", "headicon_middle");
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "r1999-cn-fake-bin-"));

  await mkdir(sourceDir, { recursive: true });
  await mkdir(path.join(assetRepo, ".git"), { recursive: true });
  await mkdir(path.join(assetRepo, "mappings"), { recursive: true });
  await writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(path.join(fakeBin, "curl"), options.curlScript, { mode: 0o755 });
  await writeFile(
    path.join(assetRepo, "mappings", "ArcanistMap.json"),
    JSON.stringify(options.upstreamMap, null, 2) + "\n"
  );
  await writeFile(
    path.join(fixtureRoot, "src", "data", "characters.json"),
    JSON.stringify(options.currentCharacters, null, 2) + "\n"
  );
  await writeFile(path.join(fixtureRoot, "scripts", "data", "ArcanistMap.json"), "[]\n");
  for (const id of options.sourcePngIds) {
    await writeFixturePng(path.join(sourceDir, `${id}.png`));
  }

  const syncSourcePath = path.join(fixtureRoot, "scripts", "sync-assets.ts");
  const syncSource = await readFile(syncSourcePath, "utf8");
  const isolatedSource = syncSource.replace(
    'const TEMP_DIR = path.join("/", "tmp", "r1999-asset-sync");',
    'const TEMP_DIR = path.join(ROOT, "asset-sync");'
  );
  assert.notEqual(isolatedSource, syncSource, "sync fixture isolates TEMP_DIR");
  await writeFile(syncSourcePath, isolatedSource);

  return { fixtureRoot, assetRepo, sourceDir, fakeBin };
}

async function executeCli(
  fixtureRoot: string,
  script: "sync-assets.ts" | "build-characters.ts",
  fakeBin?: string
): Promise<void> {
  await execFileAsync(process.execPath, [TSX_CLI, path.join("scripts", script)], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      PATH: fakeBin ? `${fakeBin}:${process.env.PATH ?? ""}` : process.env.PATH,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function readFixturePersistentState(
  fixtureRoot: string
): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  for (const file of [
    "src/data/characters.json",
    "scripts/data/uttu-supplement.json",
    "scripts/data/ArcanistMap.json",
    "scripts/data/pending-characters.json",
    "scripts/data/avatar-hash-cache.json",
  ]) {
    state[file] = await readFile(path.join(fixtureRoot, file), "base64");
  }
  const avatarDir = path.join(fixtureRoot, "public", "assets", "characters", "avatars");
  for (const file of (await readdir(avatarDir)).sort()) {
    state[`avatars/${file}`] = await readFile(path.join(avatarDir, file), "base64");
  }
  return state;
}

async function testSyncCliWithUttuOutage(): Promise<void> {
  const { fixtureRoot, fakeBin } = await setupSyncAssetFixture({
    upstreamMap: [
      entry(7100, [
        { id: 710001, des: "初始立绘" },
        { id: 710002, des: "进阶立绘" },
      ]),
    ],
    currentCharacters: [],
    sourcePngIds: ["710001", "710002"],
    curlScript: "#!/bin/sh\nexit 22\n",
  });
  try {
    await executeCli(fixtureRoot, "sync-assets.ts", fakeBin);
    const written = JSON.parse(
      await readFile(path.join(fixtureRoot, "src", "data", "characters.json"), "utf8")
    ) as Character[];
    assert.equal(written.some((c) => c.baseId === 7100), true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function testSyncCliUttuPrimaryPngAndConflictSafety(): Promise<void> {
  const existing = character(
    7400,
    [{ variantId: "740001", type: "default", skinName: null, skinNameEng: null }],
    { id: "existing-uttu-id" }
  );
  const { fixtureRoot, assetRepo, sourceDir, fakeBin } = await setupSyncAssetFixture({
    upstreamMap: [entry(7400, [{ id: 740001, des: "初始立绘" }])],
    currentCharacters: [existing],
    sourcePngIds: ["740001", "740003"],
    curlScript: "#!/bin/sh\nexit 22\n", // overwritten once HTML fixtures exist
  });
  try {
    const profilesFile = path.join(fixtureRoot, "uttu-profiles.html");
    const garmentsFile = path.join(fixtureRoot, "uttu-garments.html");
    await writeFile(
      profilesFile,
      `<script>const profiles=[{ID:7400,Name:"Existing",Rarity:5,LocaleName:{en:"Existing",zh:"角色 7400",tw:"角色 7400"}}]</script>\n`
    );
    await writeFile(
      garmentsFile,
      `<script>const garments=[
        {profile:{ID:7400},garment:{id:740001,name:{en:"Default",zh:"Default"},category:"default",global:!0}},
        {profile:{ID:7400},garment:{id:740003,name:{en:"Primary PNG Skin",zh:"主來源圖時裝"},category:"advanced",global:!1}}
      ]</script>\n`
    );
    await writeFile(
      path.join(fakeBin, "curl"),
      `#!/bin/sh
for last; do :; done
case "$last" in
  */profiles/) cat ${JSON.stringify(profilesFile)}; exit 0;;
  */garments/) cat ${JSON.stringify(garmentsFile)}; exit 0;;
  *) exit 22;;
esac
`,
      { mode: 0o755 }
    );

    // 1. Primary PNG readiness admits candidate even when UTTU asset URL fails
    await executeCli(fixtureRoot, "sync-assets.ts", fakeBin);
    const supplement = JSON.parse(
      await readFile(path.join(fixtureRoot, "scripts", "data", "uttu-supplement.json"), "utf8")
    ) as { characters: Array<Record<string, unknown>>; skins: Array<{ variantId: string }> } & Record<string, unknown>;
    assert.equal(supplement.skins.some((skin) => skin.variantId === "740003"), true);
    await validateImageParity(
      path.join(sourceDir, "740003.png"),
      path.join(fixtureRoot, "public", "assets", "characters", "avatars", "740003.webp")
    );
    const hashCache = JSON.parse(
      await readFile(path.join(fixtureRoot, "scripts", "data", "avatar-hash-cache.json"), "utf8")
    ) as Record<string, { png?: string; uttu?: unknown }>;
    assert.equal(typeof hashCache["740003"]?.png, "string");
    assert.equal(hashCache["740003"]?.uttu, undefined);

    // 2. Primary catch-up conflict aborts before publishing any file
    const conflictSkins: Character["skins"] = [
      { variantId: "770001", type: "default", skinName: null, skinNameEng: null },
      { variantId: "770002", type: "insight", skinName: "Supplement Insight", skinNameEng: "Supplement Insight" },
    ];
    const currentRoster = JSON.parse(
      await readFile(path.join(fixtureRoot, "src", "data", "characters.json"), "utf8")
    ) as Character[];
    await writeFile(
      path.join(fixtureRoot, "src", "data", "characters.json"),
      JSON.stringify(
        [
          ...currentRoster,
          character(7700, conflictSkins, {
            id: "770001",
            stage: "pending-names",
            isReleased: false,
            source: undefined,
          }),
        ],
        null,
        2
      ) + "\n"
    );
    await writeFile(
      path.join(fixtureRoot, "scripts", "data", "uttu-supplement.json"),
      JSON.stringify(
        {
          ...supplement,
          characters: [
            ...supplement.characters,
            {
              baseId: 7700,
              name: "测试角色",
              nameEng: "Test Character",
              names: { "zh-CN": "测试角色", "en-US": "Test Character" },
              rarity: 5,
              defaultVariant: "770001",
              skins: conflictSkins,
            },
          ],
        },
        null,
        2
      ) + "\n"
    );
    const upstreamMap = JSON.parse(
      await readFile(path.join(assetRepo, "mappings", "ArcanistMap.json"), "utf8")
    ) as ArcanistEntryFull[];
    await writeFile(
      path.join(assetRepo, "mappings", "ArcanistMap.json"),
      JSON.stringify(
        [
          ...upstreamMap,
          entry(7700, [
            { id: 770001, des: "初始立绘" },
            { id: 770009, des: "进阶立绘", name: "Primary Insight" },
          ]),
        ],
        null,
        2
      ) + "\n"
    );

    const beforeConflict = await readFixturePersistentState(fixtureRoot);
    await assert.rejects(
      () => executeCli(fixtureRoot, "sync-assets.ts", fakeBin),
      (error: unknown) => {
        const details = error as { code?: number | string; stderr?: string };
        assert.notEqual(Number(details.code), 0);
        const message = `${String(error)}\n${details.stderr ?? ""}`;
        assert.match(message, /baseId 7700/);
        assert.match(message, /admitted insight 770002/);
        assert.match(message, /primary 770009/);
        assert.match(message, /Resolve the upstream mapping/);
        return true;
      }
    );
    assert.deepEqual(
      await readFixturePersistentState(fixtureRoot),
      beforeConflict,
      "catch-up conflict leaves every persistent file untouched"
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function testBuildCli(): Promise<void> {
  const fixtureRoot = await createCliFixture();
  try {
    const mappedEntry = entry(7400, [
      { id: 740001, des: "初始立绘" },
      { id: 740003, des: "活动立绘", name: "Mapped skin" },
    ]);
    const existing = character(
      7400,
      [{ variantId: "740001", type: "default", skinName: null, skinNameEng: null }],
      { id: "existing-cli-id" }
    );
    await writeFile(
      path.join(fixtureRoot, "scripts", "data", "ArcanistMap.json"),
      JSON.stringify([mappedEntry], null, 2) + "\n"
    );
    await writeFile(
      path.join(fixtureRoot, "src", "data", "characters.json"),
      JSON.stringify([existing], null, 2) + "\n"
    );
    await writeFixtureWebp(
      path.join(fixtureRoot, "public", "assets", "characters", "avatars", "740001.webp"),
      { r: 255, g: 128, b: 0 }
    );
    await executeCli(fixtureRoot, "build-characters.ts");
    const written = JSON.parse(
      await readFile(path.join(fixtureRoot, "src", "data", "characters.json"), "utf8")
    ) as Character[];
    const built = written.find((c) => c.baseId === 7400);
    assert.ok(built);
    assert.equal(built.id, "existing-cli-id");
    assert.equal(built.skins.some((skin) => skin.variantId === "740003"), true);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

testEightDigitAndExplicitDefaultMapping();
testCnIngestionPlanningAndReconciliation();
testReleaseOrderThreeTiersAndIdempotency();
await testSyncCliWithUttuOutage();
await testSyncCliUttuPrimaryPngAndConflictSafety();
await testBuildCli();

console.log("CN ingestion, release ordering, and CLI checks passed.");
