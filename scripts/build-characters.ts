/**
 * build-characters — 增量維護 characters.json。
 *
 * v0.6：動態增量模式：
 * 1. 既有角色 skins[] 每次以 ArcanistMap 權威覆寫（含 type/name）
 * 2. 偵測 ArcanistMap 中尚未在 characters.json 的新角色
 * 3. 新角色有 headicon 圖片 → 加入 JSON（stage: "pending-names"）
 * 4. 新角色無圖片 → 寫入 pending-characters.json
 * 5. 重算全部角色的 releaseOrder（依 §4.7.3 規則）
 *
 * 執行：npm run build:characters
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character, PendingCharacter } from "./types";
import { recalculateReleaseOrder } from "./recalculate-order";
import { buildSkins, type ArcanistEntryFull } from "./skin-utils";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");
const PENDING_FILE = path.join(__dirname, "data/pending-characters.json");
const AVATARS_DIR = path.join(ROOT, "public/assets/characters/avatars");

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

/** Fingerprint skins for change detection (variantId + type + names) */
function skinFingerprint(skins: Character["skins"]): string {
  return JSON.stringify(
    skins.map((s) => ({ id: s.variantId, type: s.type, name: s.skinName, eng: s.skinNameEng }))
  );
}

function hasAvatarImage(variantId: string): boolean {
  return existsSync(path.join(AVATARS_DIR, `${variantId}.webp`));
}

function readDeprecatedBaseIds(): Set<number> {
  const file = path.join(__dirname, "data", "deprecated-characters.json");
  if (!existsSync(file)) return new Set();
  return new Set(
    (JSON.parse(readFileSync(file, "utf-8")) as { baseId: number }[]).map(
      (entry) => entry.baseId
    )
  );
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
  const arcanistByBase = new Map<number, ArcanistEntryFull>();
  for (const a of arcanists) arcanistByBase.set(a.id, a);

  const characters = loadJSON<Character[]>(DATA_FILE);
  const existingBaseIds = new Set(characters.map((c) => c.baseId));

  let skinsUpdated = 0;
  let skinsTotal = 0;

  // 1. Update existing: always overwrite skins[] from ArcanistMap (authority)
  //    but preserve the previous release marker until sync:release refreshes it.
  for (const character of characters) {
    const entry = arcanistByBase.get(character.baseId);
    if (!entry) continue;

    const newSkins = buildSkins(entry);
    skinsTotal += newSkins.length;

    const oldPrint = skinFingerprint(character.skins);
    const newPrint = skinFingerprint(newSkins);
    if (oldPrint !== newPrint) {
      // 保留舊 isReleased（variantId 對應）
      const oldReleased = new Map<string, boolean>();
      for (const s of character.skins) {
        if (s.isReleased !== undefined) oldReleased.set(s.variantId, s.isReleased);
      }
      for (const s of newSkins) {
        if (oldReleased.has(s.variantId)) s.isReleased = oldReleased.get(s.variantId);
        else if (s.type === "skin") s.isReleased = false; // safe until sync:release
      }
      character.skins = newSkins;
      skinsUpdated++;
    }
  }

  // 2. Detect new characters from ArcanistMap
  const deprecatedBaseIds = readDeprecatedBaseIds();
  const deprecatedSkipped = arcanists.filter(
    (entry) => deprecatedBaseIds.has(entry.id) && !existingBaseIds.has(entry.id)
  );
  if (deprecatedSkipped.length > 0) {
    console.log(
      `略過廢棄角色: ${deprecatedSkipped.map((entry) => entry.nameEng).join(", ")}`
    );
  }

  const pending: PendingCharacter[] = [];
  let added = 0;

  for (const entry of arcanists) {
    if (existingBaseIds.has(entry.id) || deprecatedBaseIds.has(entry.id)) continue;

    const defaultVariantId = `${entry.id}01`;
    const defaultVariant = defaultVariantId;

    if (hasAvatarImage(defaultVariantId)) {
      const newChar: Character = {
        id: defaultVariantId,
        name: entry.name,
        baseId: entry.id,
        releaseOrder: 0,
        enabled: true,
        skins: buildSkins(entry),
        defaultVariant,
        stage: "pending-names",
        isReleased: false,
      };
      characters.push(newChar);
      added++;
    } else {
      pending.push({
        baseId: entry.id,
        variantId: defaultVariantId,
        name: entry.name,
        nameEng: entry.nameEng,
        reason: "headicon not yet in CN asset repo",
      });
    }
  }

  // 3. Restore _kbId for Kornblume-group characters
  for (const character of characters) {
    if (character.rarity !== undefined && !character.source?.pageUrl) {
      character._kbId = character._kbId ?? character.baseId;
    }
  }

  // 4. Recalculate releaseOrder (multi-source rules)
  const ordered = recalculateReleaseOrder(characters);

  // 5. Count groups
  const wikiCount = ordered.filter((c) => c.source?.pageUrl).length;
  const kbCount = ordered.filter(
    (c) => !c.source?.pageUrl && c.rarity !== undefined
  ).length;
  const assetCount = ordered.length - wikiCount - kbCount;

  // 6. Clean temporary fields + write
  for (const c of ordered) delete c._kbId;

  writeFileSync(DATA_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf-8");

  if (pending.length > 0) {
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2) + "\n", "utf-8");
  }

  console.log(`=== 摘要 ===`);
  console.log(`現有角色: ${existingBaseIds.size} 名`);
  console.log(`Skins 更新: ${skinsUpdated}/${existingBaseIds.size} 名`);
  console.log(`Skin 總數: ${skinsTotal}`);
  console.log(`新增角色: ${added} 名`);
  console.log(`待定角色: ${pending.length} 名（見 pending-characters.json）`);
  console.log(`排序分配: Wiki ${wikiCount} / Kornblume ${kbCount} / CN Asset ${assetCount}`);
  if (pending.length > 0) {
    console.log(`\n⚠ ${pending.length} characters pending — headicon not yet available`);
    for (const p of pending) {
      console.log(`  ${p.variantId} ${p.name} (${p.nameEng})`);
    }
  }
  console.log(`\n✓ Written: ${DATA_FILE}`);
}

main();
