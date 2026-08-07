/**
 * Phase 2 — 根據 id-map.json 與 ArcanistMap.json 重建 characters.json。
 *
 * 將舊的 wiki-based schema 轉換為 v0.5 variant-based schema：
 * - id → 預設 variant ID ({baseId}01)
 * - 新增 baseId、skins[]、defaultVariant
 * - 砍掉 images 欄位
 * - 保留 names、releaseOrder、enabled、avatarPosition、rarity
 *
 * 執行：npm run build:characters
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const BACKUP_FILE = path.join(ROOT, "src/data/characters-v0.4-backup.json");
const ID_MAP = path.join(__dirname, "data/id-map.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");

/* ---------- ArcanistMap types ---------- */

interface ArcanistSkin {
  id: number;
  des: string;
  characterSkin: string;
  characterSkinNameEng: string;
}

interface ArcanistEntry {
  id: number;
  name: string;
  nameEng: string;
  live2d: ArcanistSkin[];
}

/* ---------- Old character ---------- */

interface OldCharacter {
  id: string;
  name: string;
  names?: Record<string, string>;
  rarity?: number;
  releaseOrder: number;
  enabled: boolean;
  images: {
    full: string;
    avatar: string;
    insight?: string;
  };
  avatarPosition?: { x: number; y: number };
  source?: { pageUrl?: string; imageUrl?: string };
}

/* ---------- New character ---------- */

type SkinType = "default" | "insight" | "skin";

interface CharacterSkinNew {
  variantId: string;
  type: SkinType;
  skinName: string | null;
  skinNameEng: string | null;
}

interface NewCharacter {
  id: string;
  name: string;
  baseId: number;
  releaseOrder: number;
  enabled: boolean;
  names?: Record<string, string>;
  rarity?: number;
  skins: CharacterSkinNew[];
  defaultVariant: string;
  avatarPosition?: { x: number; y: number };
  source?: { pageUrl?: string; imageUrl?: string };
}

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function skinTypeFromId(variantId: number, _des: string): SkinType {
  const suffix = variantId % 100;
  if (suffix === 1) return "default";
  if (suffix === 2) return "insight";
  return "skin";
}

function main(): void {
  console.log("Phase 2: build-characters\n");

  if (!existsSync(ID_MAP)) {
    console.error("✗ id-map.json not found — run Phase 1 first (npm run build:id-map)");
    process.exit(1);
  }
  if (!existsSync(ARCANIST_MAP)) {
    console.error("✗ ArcanistMap.json not found in scripts/data/");
    process.exit(1);
  }
  if (!existsSync(DATA_FILE)) {
    console.error(`✗ ${DATA_FILE} not found`);
    process.exit(1);
  }

  const oldChars = loadJSON<OldCharacter[]>(DATA_FILE);
  const idMap = loadJSON<Record<string, string>>(ID_MAP);
  const arcanists = loadJSON<ArcanistEntry[]>(ARCANIST_MAP);

  // Build lookup: baseId → ArcanistEntry
  const arcanistByBase = new Map<number, ArcanistEntry>();
  for (const a of arcanists) {
    arcanistByBase.set(a.id, a);
  }

  const newChars: NewCharacter[] = [];
  const warnings: string[] = [];
  let skinTotal = 0;

  for (const old of oldChars) {
    const variantId = idMap[old.id];
    if (!variantId || variantId.startsWith("UNMAPPED_")) {
      warnings.push(`${old.id} ${old.name}: no mapping — skipped`);
      continue;
    }

    const baseId = Math.floor(Number(variantId) / 100);
    const arcanist = arcanistByBase.get(baseId);

    if (!arcanist) {
      warnings.push(`${variantId} (${old.name}): baseId ${baseId} not in ArcanistMap — skipped`);
      continue;
    }

    // Build skins[]
    const skins: CharacterSkinNew[] = arcanist.live2d.map((s) => ({
      variantId: String(s.id),
      type: skinTypeFromId(s.id, s.des),
      skinName: s.characterSkin || null,
      skinNameEng: s.characterSkinNameEng || null,
    }));

    // Default to 02 if available, else 01
    const hasInsight = skins.some((s) => s.variantId === `${baseId}02`);
    const defaultVariant = hasInsight ? `${baseId}02` : `${baseId}01`;

    const newChar: NewCharacter = {
      id: `${baseId}01`,
      name: old.name,
      baseId,
      releaseOrder: old.releaseOrder,
      enabled: old.enabled,
      names: old.names,
      rarity: old.rarity,
      skins,
      defaultVariant,
      avatarPosition: old.avatarPosition,
      source: old.source,
    };

    newChars.push(newChar);
    skinTotal += skins.length;
  }

  // Sort by releaseOrder
  newChars.sort((a, b) => a.releaseOrder - b.releaseOrder);

  // Warn
  if (warnings.length > 0) {
    console.warn(`⚠ ${warnings.length} characters could not be mapped:`);
    for (const w of warnings) console.warn(`  ${w}`);
  }

  // Backup old
  writeFileSync(BACKUP_FILE, JSON.stringify(oldChars, null, 2) + "\n", "utf-8");
  console.log(`Backup: ${BACKUP_FILE}`);

  // Write new
  writeFileSync(DATA_FILE, JSON.stringify(newChars, null, 2) + "\n", "utf-8");

  console.log(`\nOld characters: ${oldChars.length}`);
  console.log(`New characters: ${newChars.length}`);
  console.log(`Total skins: ${skinTotal} (avg ${(skinTotal / newChars.length).toFixed(1)}/char)`);
  console.log(`Default variant: 02 (insight) where available, else 01`);
  console.log(`\n✓ Written: ${DATA_FILE}`);
  console.log("⚠ characters.ts may need updating for new schema");
}

main();
