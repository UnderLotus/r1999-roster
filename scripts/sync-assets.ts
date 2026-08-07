/**
 * Phase 3 — 同步官方素材。
 *
 * 1. 清空舊的 wiki-based 圖片目錄
 * 2. 從官方 CN asset repo shallow-clone headicon_middle/
 * 3. 將匹配 characters.json skins[] 的 PNG 複製到 avatars/ 扁平目錄
 *
 * 執行：npm run sync
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const AVATARS_DIR = path.join(ROOT, "public/assets/characters/avatars");
const OLD_ASSETS_DIR = path.join(ROOT, "public/assets/characters");

const ASSET_REPO = "https://github.com/myssal/Reverse-1999-CN-Asset.git";
const TEMP_DIR = path.join("/", "tmp", "r1999-asset-sync");
const SOURCE_DIR = path.join(TEMP_DIR, "singlebg", "headicon_middle");

/* ---------- New character schema (subset) ---------- */

interface CharacterSkinNew {
  variantId: string;
}

interface NewCharacter {
  id: string;
  skins: CharacterSkinNew[];
}

function loadJSON<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function main(): void {
  console.log("Phase 3: sync-assets\n");

  if (!existsSync(DATA_FILE)) {
    console.error(`✗ ${DATA_FILE} not found — run Phase 2 first (npm run build:characters)`);
    process.exit(1);
  }

  const characters = loadJSON<NewCharacter[]>(DATA_FILE);

  // Collect all variant IDs used by characters
  const usedVariants = new Set<string>();
  for (const c of characters) {
    for (const skin of c.skins) {
      usedVariants.add(skin.variantId);
    }
  }
  console.log(`Characters: ${characters.length}`);
  console.log(`Expected variant images: ${usedVariants.size}`);

  // 1. Wipe old wiki-based subdirectories
  console.log("\n→ Wiping old asset directories...");
  let wiped = 0;
  if (existsSync(OLD_ASSETS_DIR)) {
    const oldEntries = readdirSync(OLD_ASSETS_DIR);
    for (const entry of oldEntries) {
      if (entry === "avatars") continue;
      const entryPath = path.join(OLD_ASSETS_DIR, entry);
      try {
        rmSync(entryPath, { recursive: true, force: true });
        wiped++;
      } catch {
        console.warn(`  Failed to remove: ${entry}`);
      }
    }
  }
  console.log(`  Wiped ${wiped} old directories`);

  // 2. Prepare avatars/ directory
  if (!existsSync(AVATARS_DIR)) {
    mkdirSync(AVATARS_DIR, { recursive: true });
  }

  // 3. Shallow-clone official asset repo (sparse checkout headicon_middle/)
  console.log("\n→ Cloning official asset repo (shallow, sparse)...");
  if (existsSync(TEMP_DIR)) {
    run("rm", ["-rf", TEMP_DIR]);
  }

  let cloneFailed = false;
  try {
    run("git", [
      "clone",
      "--depth", "1",
      "--filter=blob:none",
      "--sparse",
      ASSET_REPO,
      TEMP_DIR,
    ]);
    run("git", ["sparse-checkout", "set", "singlebg/headicon_middle"], TEMP_DIR);
    run("git", ["checkout"], TEMP_DIR);
  } catch (err) {
    console.error(`✗ Failed to clone/sparse-checkout asset repo: ${String(err)}`);
    cloneFailed = true;
  }

  if (cloneFailed) {
    try { run("rm", ["-rf", TEMP_DIR]); } catch { /* best effort */ }
    process.exit(1);
  }

  // 4. Copy matching variant images
  console.log("→ Copying variant images...");
  let copied = 0;
  let skipped = 0;
  const missingList: string[] = [];

  for (const variantId of usedVariants) {
    const src = path.join(SOURCE_DIR, `${variantId}.png`);
    const dst = path.join(AVATARS_DIR, `${variantId}.png`);

    if (!existsSync(src)) {
      missingList.push(variantId);
      continue;
    }

    try {
      copyFileSync(src, dst);
      copied++;
    } catch {
      skipped++;
    }
  }

  if (missingList.length > 0) {
    console.warn(`\n⚠ ${missingList.length} variant images missing from source:`);
    for (const id of missingList) {
      console.warn(`  ${id}`);
    }
  }

  // 5. Cleanup temp clone
  console.log("\n→ Cleaning up temp clone...");
  try {
    run("rm", ["-rf", TEMP_DIR]);
  } catch {
    console.warn("  Failed to remove temp directory");
  }

  console.log(`\n=== Summary ===`);
  console.log(`Wiped: ${wiped} old directories`);
  console.log(`Copied: ${copied} images`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Missing: ${missingList.length}`);
  console.log(`\n✓ Assets in: ${AVATARS_DIR}`);
}

try {
  main();
} catch (err) {
  console.error("sync-assets failed:", err);
  process.exit(1);
}
