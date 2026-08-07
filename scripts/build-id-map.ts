/**
 * Phase 1 — 產生 wiki → variant ID 對照表。
 *
 * 驗證現有 characters.json 的 id 是否已為官方 variant ID，並產生
 * id-map.json（identity mapping for now; 保留未來非 identity 的對應能力）。
 *
 * 執行：npm run build:id-map
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");
const OUT_FILE = path.join(__dirname, "data/id-map.json");

/* ---------- ArcanistMap types ---------- */

interface ArcanistEntry {
  id: number;
  name: string;
  nameEng: string;
  live2d: {
    id: number;
    name: string;
    nameEng: string;
    des: string;
    characterSkin: string;
    characterSkinNameEng: string;
  }[];
}

/* ---------- existing character (subset) ---------- */

interface OldCharacter {
  id: string;
  name: string;
  names?: Record<string, string>;
}

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function main(): void {
  console.log("Phase 1: build-id-map\n");

  const characters = loadJSON<OldCharacter[]>(DATA_FILE);
  const arcanists = loadJSON<ArcanistEntry[]>(ARCANIST_MAP);

  // Build lookup: variant ID → (baseId, skin info)
  const variantMap = new Map<number, { baseId: number; des: string }>();
  for (const entry of arcanists) {
    for (const skin of entry.live2d) {
      variantMap.set(skin.id, { baseId: entry.id, des: skin.des });
    }
  }

  // Build name → baseId lookup
  const nameToBase = new Map<string, number>();
  for (const entry of arcanists) {
    nameToBase.set(entry.name, entry.id);
  }

  // Build en-name → baseId lookup (fallback)
  const enToBase = new Map<string, number>();
  for (const entry of arcanists) {
    enToBase.set(entry.nameEng, entry.id);
  }

  const idMap: Record<string, string> = {};
  const auto = { count: 0, variantMismatch: 0 };
  const manual: string[] = [];
  let nameMatch = 0;
  let enMatch = 0;

  for (const c of characters) {
    const numericId = Number(c.id);
    const variantInfo = variantMap.get(numericId);

    if (variantInfo) {
      // ID is already a valid variant ID → identity mapping
      idMap[c.id] = c.id;
      auto.count++;
      continue;
    }

    // Not a recognized variant — try name matching
    const cnBase = nameToBase.get(c.name);
    if (cnBase) {
      idMap[c.id] = `${cnBase}01`;
      nameMatch++;
      continue;
    }

    // Try English name matching
    const enName = c.names?.["en-US"];
    if (enName) {
      const enBase = enToBase.get(enName);
      if (enBase) {
        idMap[c.id] = `${enBase}01`;
        enMatch++;
        continue;
      }
    }

    // Cannot match → manual review
    manual.push(`${c.id} ${c.name} (en=${c.names?.["en-US"] ?? "?"})`);
    idMap[c.id] = `UNMAPPED_${c.id}`;
  }

  console.log(`characters.json: ${characters.length} entries`);
  console.log(`ArcanistMap: ${arcanists.length} base characters, ${variantMap.size} variants\n`);
  console.log(`Auto (already variant ID): ${auto.count}`);
  console.log(`Name-matched (zh-CN): ${nameMatch}`);
  console.log(`Name-matched (en-US): ${enMatch}`);
  console.log(`Manual review needed: ${manual.length}`);
  if (manual.length > 0) {
    console.warn("\n⚠ Manual review required:");
    for (const m of manual) console.warn(`  ${m}`);
  }

  // Write
  if (existsSync(OUT_FILE)) {
    console.error(`\n✗ ${OUT_FILE} already exists — delete it first`);
    process.exit(1);
  }

  writeFileSync(OUT_FILE, JSON.stringify(idMap, null, 2) + "\n", "utf-8");
  console.log(`\n✓ Written: ${OUT_FILE}`);
}

main();
