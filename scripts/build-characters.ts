/**
 * build-characters — 增量維護 characters.json。
 *
 * The CN decision surface is shared with sync-assets through the pure
 * cn-ingestion plan. This adapter owns only local inventory, ordering, and
 * writes; its historical readiness contract checks the mapped default local
 * avatar rather than requiring every mapped source PNG.
 *
 * 執行：npm run build:characters
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Character } from "./types";
import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type CnDeprecatedEntry,
  type CnIngestionPlan,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import { recalculateReleaseOrder } from "./recalculate-order";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");
const PENDING_FILE = path.join(__dirname, "data/pending-characters.json");
const AVATARS_DIR = path.join(ROOT, "public/assets/characters/avatars");

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/** Fingerprint skins for change detection (variantId + type + names). */
function skinFingerprint(skins: Character["skins"]): string {
  return JSON.stringify(
    skins.map((skin) => ({
      id: skin.variantId,
      type: skin.type,
      name: skin.skinName,
      eng: skin.skinNameEng,
    }))
  );
}

function collectLocalImageIds(): Set<string> {
  if (!existsSync(AVATARS_DIR)) return new Set();
  return new Set(
    readdirSync(AVATARS_DIR)
      .filter((file) => file.endsWith(".webp"))
      .map((file) => file.slice(0, -".webp".length))
  );
}

function readDeprecatedEntries(): CnDeprecatedEntry[] {
  const file = path.join(__dirname, "data", "deprecated-characters.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8")) as CnDeprecatedEntry[];
}

/** Apply only build:characters' existing/new roster reconciliation projection. */
export function applyBuildPlan(
  characters: Character[],
  plan: CnIngestionPlan
): void {
  const reconciliations = new Map(
    plan.existingCharacterReconciliations.map((reconciliation) => [
      reconciliation.baseId,
      reconciliation.after,
    ])
  );
  for (let index = 0; index < characters.length; index++) {
    const reconciled = reconciliations.get(characters[index].baseId);
    if (reconciled) characters[index] = cloneCharacterRecord(reconciled);
  }
  for (const character of plan.build.readyNewCharacters) {
    characters.push(cloneCharacterRecord(character));
  }
}

/** Apply build reconciliation, ordering, and temporary-field cleanup exactly as the CLI does. */
export function finalizeBuildPlan(
  characters: Character[],
  plan: CnIngestionPlan
): Character[] {
  applyBuildPlan(characters, plan);

  for (const character of characters) {
    if (character.rarity !== undefined && !character.source?.pageUrl) {
      character._kbId = character._kbId ?? character.baseId;
    }
  }

  const ordered = recalculateReleaseOrder(characters);
  for (const character of ordered) delete character._kbId;
  return ordered;
}

function main(): void {
  console.log("build-characters (v0.6 incremental)\n");

  if (!existsSync(DATA_FILE)) {
    console.error("✗ characters.json not found — run sync first");
    process.exit(1);
  }
  if (!existsSync(ARCANIST_MAP)) {
    console.error("✗ ArcanistMap.json not found");
    process.exit(1);
  }

  const arcanists = loadJSON<ArcanistEntryFull[]>(ARCANIST_MAP);
  const mappedCharacters = arcanists.map(mapCnCharacterMetadata);
  const characters = loadJSON<Character[]>(DATA_FILE);
  const existingCharacterCount = characters.length;
  const existingBaseIds = new Set(characters.map((character) => character.baseId));
  const plan = planCnIngestion({
    currentCharacters: characters,
    mappedCharacters,
    // build:characters intentionally does not use source-PNG readiness. The
    // pure plan still receives the explicit inventory required by its shared
    // interface, while build reads only local WebP availability below.
    sourceImageIds: new Set(),
    localImageIds: collectLocalImageIds(),
    deprecatedEntries: readDeprecatedEntries(),
  });

  const skinsUpdated = plan.existingCharacterReconciliations.filter(
    (reconciliation) =>
      skinFingerprint(reconciliation.before.skins) !==
      skinFingerprint(reconciliation.after.skins)
  ).length;
  const skinsTotal = plan.existingCharacterReconciliations.reduce(
    (total, reconciliation) => total + reconciliation.mapped.skins.length,
    0
  );

  if (plan.deprecatedSkips.length > 0) {
    console.log(
      `略過廢棄角色: ${plan.deprecatedSkips
        .map((mapped) => mapped.nameEng)
        .join(", ")}`
    );
  }

  const ordered = finalizeBuildPlan(characters, plan);

  // Count groups.
  const wikiCount = ordered.filter((character) => character.source?.pageUrl).length;
  const kbCount = ordered.filter(
    (character) => !character.source?.pageUrl && character.rarity !== undefined
  ).length;
  const assetCount = ordered.length - wikiCount - kbCount;

  // Write the finalized roster.
  writeFileSync(DATA_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf-8");
  writeFileSync(
    PENDING_FILE,
    JSON.stringify(plan.build.pendingNewCharacters, null, 2) + "\n",
    "utf-8"
  );

  console.log(`=== 摘要 ===`);
  console.log(`現有角色: ${existingBaseIds.size} 名`);
  console.log(`Skins 更新: ${skinsUpdated}/${existingCharacterCount} 名`);
  console.log(`Skin 總數: ${skinsTotal}`);
  console.log(`新增角色: ${plan.build.readyNewCharacters.length} 名`);
  console.log(
    `待定角色: ${plan.build.pendingNewCharacters.length} 名（見 pending-characters.json）`
  );
  console.log(`略過廢棄角色: ${plan.deprecatedSkips.length} 名`);
  console.log(`排序分配: Wiki ${wikiCount} / Kornblume ${kbCount} / CN Asset ${assetCount}`);
  if (plan.build.pendingNewCharacters.length > 0) {
    console.log(
      `\n⚠ ${plan.build.pendingNewCharacters.length} characters pending — headicon not yet available`
    );
    for (const pending of plan.build.pendingNewCharacters) {
      console.log(
        `  ${pending.variantId} ${pending.name} (${pending.nameEng})`
      );
    }
  }
  console.log(`\n✓ Written: ${DATA_FILE}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) main();
