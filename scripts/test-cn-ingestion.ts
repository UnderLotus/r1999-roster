import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import sharp from "sharp";

import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type ArcanistEntryFull,
  type CnMappedCharacterMetadata,
} from "./cn-ingestion";
import {
  applyBuildPlan,
  finalizeBuildPlan,
} from "./build-characters";
import {
  applySyncPlan,
  collectMappingLagCandidates,
  reportSyncDiagnostics,
} from "./sync-assets";
import type { Character } from "./types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const TSX_CLI = path.join(ROOT, "node_modules/tsx/dist/cli.mjs");
const CLI_SOURCE_FILES = [
  "build-characters.ts",
  "cn-ingestion.ts",
  "recalculate-order.ts",
  "skin-utils.ts",
  "sync-assets.ts",
  "types.ts",
  "webp-converter.ts",
] as const;

function entry(
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

function mapped(entryValue: ArcanistEntryFull): CnMappedCharacterMetadata {
  return mapCnCharacterMetadata(entryValue);
}

async function writeFixturePng(file: string): Promise<void> {
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toFile(file);
}

async function writeFixtureWebp(
  file: string,
  background: { r: number; g: number; b: number }
): Promise<void> {
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { ...background, alpha: 1 },
    },
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
  for (const file of CLI_SOURCE_FILES) {
    await cp(path.join(ROOT, "scripts", file), path.join(fixtureRoot, "scripts", file));
  }
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

async function runSyncCli(): Promise<Character[]> {
  const fixtureRoot = await createCliFixture();
  const assetRepo = path.join(fixtureRoot, "asset-sync");
  const sourceDir = path.join(assetRepo, "singlebg", "headicon_middle");
  const fakeBin = await mkdtemp(path.join(os.tmpdir(), "r1999-cn-fake-git-"));
  try {
    const mappedEntry = entry(7100, [
      { id: 710001, des: "初始立绘" },
      { id: 710002, des: "进阶立绘" },
    ]);
    await mkdir(sourceDir, { recursive: true });
    await mkdir(path.join(assetRepo, ".git"), { recursive: true });
    await mkdir(path.join(assetRepo, "mappings"), { recursive: true });
    await writeFile(path.join(fakeBin, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      path.join(assetRepo, "mappings", "ArcanistMap.json"),
      JSON.stringify([mappedEntry], null, 2) + "\n"
    );
    await writeFile(path.join(fixtureRoot, "src", "data", "characters.json"), "[]\n");
    await writeFile(path.join(fixtureRoot, "scripts", "data", "ArcanistMap.json"), "[]\n");
    await writeFixturePng(path.join(sourceDir, "710001.png"));
    await writeFixturePng(path.join(sourceDir, "710002.png"));
    const sourcePath = path.join(fixtureRoot, "scripts", "sync-assets.ts");
    const source = await readFile(sourcePath, "utf8");
    const isolatedSource = source.replace(
      'const TEMP_DIR = path.join("/", "tmp", "r1999-asset-sync");',
      'const TEMP_DIR = path.join(ROOT, "asset-sync");'
    );
    assert.notEqual(isolatedSource, source, "sync fixture isolates the asset repository path");
    await writeFile(sourcePath, isolatedSource);
    await executeCli(fixtureRoot, "sync-assets.ts", fakeBin);
    return JSON.parse(
      await readFile(path.join(fixtureRoot, "src", "data", "characters.json"), "utf8")
    ) as Character[];
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
    await rm(fakeBin, { recursive: true, force: true });
  }
}

async function runBuildCli(): Promise<Character[]> {
  const fixtureRoot = await createCliFixture();
  try {
    const mappedEntry = entry(7400, [
      { id: 740001, des: "初始立绘" },
      { id: 740003, des: "活动立绘", name: "Mapped skin" },
    ]);
    const existing = character(7400, [
      { variantId: "740001", type: "default", skinName: null, skinNameEng: null },
    ], { id: "existing-cli-id" });
    await writeFile(
      path.join(fixtureRoot, "scripts", "data", "ArcanistMap.json"),
      JSON.stringify([mappedEntry], null, 2) + "\n"
    );
    await writeFile(
      path.join(fixtureRoot, "src", "data", "characters.json"),
      JSON.stringify([existing], null, 2) + "\n"
    );
    await writeFile(path.join(fixtureRoot, "scripts", "data", "pending-characters.json"), "[]\n");
    await writeFixtureWebp(
      path.join(fixtureRoot, "public", "assets", "characters", "avatars", "740001.webp"),
      { r: 255, g: 128, b: 0 }
    );
    await executeCli(fixtureRoot, "build-characters.ts");
    return JSON.parse(
      await readFile(path.join(fixtureRoot, "src", "data", "characters.json"), "utf8")
    ) as Character[];
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

const existingEntry = entry(7400, [
  { id: 740001, des: "初始立绘" },
  { id: 740003, des: "活动立绘", name: "Existing omitted skin" },
  { id: 740006, des: "活动立绘", name: "Existing false skin" },
  { id: 740005, des: "活动立绘", name: "Fresh skin" },
]);
const readyEntry = entry(7100, [
  { id: 710001, des: "初始立绘" },
  { id: 710002, des: "进阶立绘" },
]);
const missingNondefaultEntry = entry(7200, [
  { id: 720001, des: "初始立绘" },
  { id: 720003, des: "活动立绘" },
]);
const missingDefaultEntry = entry(7300, [
  { id: 730001, des: "初始立绘" },
]);
const deprecatedEntry = entry(3029, [
  { id: 302901, des: "初始立绘" },
]);
const existing = character(7400, [
  {
    variantId: "740001",
    type: "default",
    skinName: null,
    skinNameEng: null,
    isReleased: true,
  },
  {
    variantId: "740003",
    type: "skin",
    skinName: "Existing omitted skin",
    skinNameEng: "Existing omitted skin",
  },
  {
    variantId: "740006",
    type: "skin",
    skinName: "Existing false skin",
    skinNameEng: "Existing false skin",
    isReleased: false,
  },
], { id: "existing-character-id" });
const mappedCharacters = [
  mapped(deprecatedEntry),
  mapped(missingDefaultEntry),
  mapped(readyEntry),
  mapped(existingEntry),
  mapped(missingNondefaultEntry),
];
const sourceImageIds = new Set([
  "740001",
  "740003",
  "740006",
  "740005",
  "710001",
  "710002",
  "720001",
]);
const localImageIds = new Set([
  "740001",
  "740003",
  "740006",
  "740005",
  "710001",
  "720001",
]);
const currentBefore = JSON.stringify([existing]);
const plan = planCnIngestion({
  currentCharacters: [existing],
  mappedCharacters,
  sourceImageIds,
  localImageIds,
  deprecatedEntries: [{ baseId: 3029, variantId: "302901" }],
});

assert.deepEqual(JSON.stringify([existing]), currentBefore, "planning does not mutate the roster");
assert.equal(plan.existingCharacterReconciliations.length, 1);
assert.equal(plan.existingCharacterReconciliations[0].after.id, "existing-character-id");
assert.equal(plan.existingCharacterReconciliations[0].after.defaultVariant, "740001");
assert.equal(
  plan.existingCharacterReconciliations[0].after.skins.find((skin) => skin.variantId === "740001")?.isReleased,
  true,
  "existing release status is preserved"
);
const reconciledSkins = plan.existingCharacterReconciliations[0].after.skins;
assert.equal(
  Object.prototype.hasOwnProperty.call(
    reconciledSkins.find((skin) => skin.variantId === "740003"),
    "isReleased"
  ),
  false,
  "existing omitted release marker remains omitted"
);
assert.equal(
  reconciledSkins.find((skin) => skin.variantId === "740006")?.isReleased,
  false,
  "existing explicit false release marker is preserved"
);
assert.equal(
  reconciledSkins.find((skin) => skin.variantId === "740005")?.isReleased,
  false,
  "genuinely new mapped skin receives provisional false"
);
assert.equal(plan.existingCharacterReconciliations[0].after.source?.pageUrl, existing.source?.pageUrl);

assert.deepEqual(
  plan.sync.readyNewCharacters.map((candidate) => candidate.baseId),
  [7100],
  "sync admits only all-source-ready new Characters"
);
assert.deepEqual(
  plan.sync.pendingNewCharacters.map((candidate) => candidate.baseId),
  [7200, 7300],
  "sync keeps a nondefault or default source gap pending"
);
assert.deepEqual(
  plan.build.readyNewCharacters.map((candidate) => candidate.baseId),
  [7100, 7200],
  "standalone build keeps its mapped-default local readiness contract"
);
assert.deepEqual(
  plan.build.pendingNewCharacters.map((candidate) => candidate.baseId),
  [7300],
  "standalone build only requires the mapped default local avatar"
);
assert.deepEqual(
  plan.deprecatedSkips.map((candidate) => candidate.baseId),
  [3029],
  "deprecated entries are explicit skips"
);
assert.ok(plan.requiredVariantIds.includes("720003"));
assert.ok(!plan.stagedVariantIds.includes("720003"));
assert.ok(!plan.requiredVariantIds.includes("302901"));

const syncRoster = [existing];
applySyncPlan(syncRoster, plan);
assert.equal(syncRoster.length, 2);
assert.equal(syncRoster[0].defaultVariant, "740001", "sync does not apply build reconciliation");
assert.equal(syncRoster.some((candidate) => candidate.baseId === 7200), false);

const buildRoster = [existing];
applyBuildPlan(buildRoster, plan);
assert.equal(buildRoster.length, 3);
assert.equal(buildRoster.find((candidate) => candidate.baseId === 7400)?.skins.length, 4);
assert.equal(buildRoster.some((candidate) => candidate.baseId === 7200), true);
assert.equal(buildRoster.some((candidate) => candidate.baseId === 7300), false);

const reorderedPlan = planCnIngestion({
  currentCharacters: [existing],
  mappedCharacters: [...mappedCharacters].reverse(),
  sourceImageIds: new Set(sourceImageIds),
  localImageIds: new Set(localImageIds),
  deprecatedEntries: [{ baseId: 3029, variantId: "302901" }],
});
assert.deepEqual(reorderedPlan.requiredVariantIds, plan.requiredVariantIds, "required union is stable");
assert.deepEqual(reorderedPlan.stagedVariantIds, plan.stagedVariantIds, "staged union is stable");

const buildAgain = planCnIngestion({
  currentCharacters: buildRoster,
  mappedCharacters,
  sourceImageIds,
  localImageIds,
  deprecatedEntries: [{ baseId: 3029, variantId: "302901" }],
});
assert.deepEqual(buildAgain.build.readyNewCharacters, [], "build rerun is idempotent");
assert.deepEqual(
  buildAgain.build.pendingNewCharacters.map((pending) => pending.baseId),
  [7300],
  "build rerun preserves the same pending decision"
);

const firstFinalized = finalizeBuildPlan([existing], plan);
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
assert.deepEqual(
  secondFinalized,
  firstFinalized,
  "two actual build finalizations are full-output idempotent"
);

const syncCliRoster = await runSyncCli();
assert.ok(
  syncCliRoster.some((candidate) => candidate.baseId === 7100),
  "sync CLI applies the sync plan to the written roster"
);
const buildCliRoster = await runBuildCli();
const buildCliCharacter = buildCliRoster.find((candidate) => candidate.baseId === 7400);
assert.ok(buildCliCharacter);
assert.equal(buildCliCharacter.id, "existing-cli-id");
assert.ok(
  buildCliCharacter.skins.some((skin) => skin.variantId === "740003"),
  "build CLI finalization applies mapped existing skins"
);

const warningCandidates = collectMappingLagCandidates(
  new Set(["315501", "410101", "610301"]),
  new Set(),
  new Set()
);
assert.deepEqual(warningCandidates.map((candidate) => candidate.variantId), ["315501"]);
const warningPlan = planCnIngestion({
  currentCharacters: [],
  mappedCharacters: [],
  sourceImageIds: new Set(["315501", "410101", "610301"]),
  localImageIds: new Set(),
  deprecatedEntries: [],
  diagnosticCandidates: warningCandidates,
});
assert.deepEqual(warningPlan.diagnostics.map((diagnostic) => diagnostic.id), ["cn-mapping-lag:315501"]);
assert.equal(warningPlan.diagnostics[0]?.blocking, false);
assert.deepEqual(warningPlan.sync.pendingNewCharacters, []);
const warnings: string[] = [];
reportSyncDiagnostics(warningPlan.diagnostics, (message) => warnings.push(message));
assert.equal(warnings.length, 1);
assert.match(warnings[0], /315501/);
const warningRoster: Character[] = [];
applySyncPlan(warningRoster, warningPlan);
assert.deepEqual(warningRoster, [], "mapping lag never becomes roster or pending ownership");

console.log("CN ingestion plan and adapter checks passed.");
