/**
 * Phase 3 — 同步官方素材 + 新角色偵測。
 *
 * 1. 從官方 CN asset repo shallow-clone headicon_middle/
 * 2. 將匹配 characters.json skins[] 的 PNG 轉成 validated lossless WebP
 * 3. 只有整批驗證成功後才替換 avatars/，避免部分更新
 * 4. 偵測 ArcanistMap 中的新角色，有圖片就自動加入 characters.json
 *
 * 執行：npm run sync
 */

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Character, PendingCharacter } from "./types";
import { recalculateReleaseOrder } from "./recalculate-order";
import { buildSkins, type ArcanistEntryFull } from "./skin-utils";
import { convertPngToLosslessWebp } from "./webp-converter";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_FILE = path.join(ROOT, "src/data/characters.json");
const ARCANIST_MAP = path.join(__dirname, "data/ArcanistMap.json");
const PENDING_FILE = path.join(__dirname, "data/pending-characters.json");
const AVATARS_DIR = path.join(ROOT, "public/assets/characters/avatars");
const OLD_ASSETS_DIR = path.join(ROOT, "public/assets/characters");
const VERTIN_PNG = path.join(ROOT, "public/assets/vertin_question.png");
const VERTIN_WEBP = path.join(ROOT, "public/assets/vertin_question.webp");

const ASSET_REPO = "https://github.com/myssal/Reverse-1999-CN-Asset.git";
const TEMP_DIR = path.join("/", "tmp", "r1999-asset-sync");
const SOURCE_DIR = path.join(TEMP_DIR, "singlebg", "headicon_middle");

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

function collectVariantIds(characters: readonly Character[]): Set<string> {
  const variants = new Set<string>();
  for (const character of characters) {
    for (const skin of character.skins) variants.add(skin.variantId);
  }
  return variants;
}

function collectNewEntries(
  arcanists: readonly ArcanistEntryFull[],
  existingBaseIds: ReadonlySet<number>,
  assetDir: string
): { ready: ArcanistEntryFull[]; pending: PendingCharacter[] } {
  const ready: ArcanistEntryFull[] = [];
  const pending: PendingCharacter[] = [];

  for (const entry of arcanists) {
    if (existingBaseIds.has(entry.id)) continue;
    const defaultVariantId = `${entry.id}01`;
    if (existsSync(path.join(assetDir, `${defaultVariantId}.webp`))) {
      ready.push(entry);
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

  return { ready, pending };
}

async function stageVariantImages(
  variantIds: ReadonlySet<string>,
  stagingDir: string
): Promise<void> {
  const missing = [...variantIds].filter(
    (variantId) => !existsSync(path.join(SOURCE_DIR, `${variantId}.png`))
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} expected source image(s): ${missing.join(", ")}`
    );
  }

  for (const variantId of variantIds) {
    await convertPngToLosslessWebp(
      path.join(SOURCE_DIR, `${variantId}.png`),
      path.join(stagingDir, `${variantId}.webp`)
    );
  }

  const stagedFiles = readdirSync(stagingDir);
  const expectedFiles = new Set(
    [...variantIds].map((variantId) => `${variantId}.webp`)
  );
  if (
    stagedFiles.length !== expectedFiles.size ||
    stagedFiles.some((file) => !expectedFiles.has(file))
  ) {
    throw new Error(
      `Staged avatar coverage mismatch: expected ${expectedFiles.size}, got ${stagedFiles.length}`
    );
  }
}

async function replaceStagedAssets(
  stagingRoot: string,
  hasStagedVertin: boolean
): Promise<void> {
  const stagedAvatars = path.join(stagingRoot, "avatars");
  const avatarBackup = path.join(
    OLD_ASSETS_DIR,
    `.avatars-backup-${randomUUID()}`
  );
  const vertinBackup = path.join(
    path.dirname(VERTIN_WEBP),
    `.vertin-backup-${randomUUID()}`
  );
  const stagedVertin = path.join(stagingRoot, "vertin_question.webp");
  let avatarMoved = false;
  let vertinMoved = false;
  let oldVertinMoved = false;

  try {
    if (existsSync(AVATARS_DIR)) {
      await rename(AVATARS_DIR, avatarBackup);
    }
    await rename(stagedAvatars, AVATARS_DIR);
    avatarMoved = true;

    if (hasStagedVertin) {
      if (existsSync(VERTIN_WEBP)) {
        await rename(VERTIN_WEBP, vertinBackup);
        oldVertinMoved = true;
      }
      await rename(stagedVertin, VERTIN_WEBP);
      vertinMoved = true;
    }
  } catch (error) {
    if (vertinMoved) {
      await rm(VERTIN_WEBP, { force: true });
    }
    if (oldVertinMoved) {
      await rename(vertinBackup, VERTIN_WEBP);
    }
    if (avatarMoved) {
      await rm(AVATARS_DIR, { recursive: true, force: true });
    }
    if (existsSync(avatarBackup)) {
      await rename(avatarBackup, AVATARS_DIR);
    }
    throw error;
  }

  await rm(avatarBackup, { recursive: true, force: true });
  if (oldVertinMoved) await rm(vertinBackup, { force: true });
  if (existsSync(VERTIN_PNG)) await rm(VERTIN_PNG, { force: true });
}

async function main(): Promise<void> {
  console.log("Phase 3: sync-assets\n");

  if (!existsSync(DATA_FILE)) {
    throw new Error(
      `${DATA_FILE} not found — run Phase 2 first (npm run build:characters)`
    );
  }

  const characters = loadJSON<Character[]>(DATA_FILE);
  const arcanists = loadJSON<ArcanistEntryFull[]>(ARCANIST_MAP);
  const existingBaseIds = new Set(characters.map((character) => character.baseId));

  console.log(`Characters: ${characters.length}`);
  console.log(`Current variant images: ${collectVariantIds(characters).size}`);

  if (existsSync(TEMP_DIR)) run("rm", ["-rf", TEMP_DIR]);

  let stagingRoot: string | undefined;
  try {
    console.log("→ Cloning official asset repo (shallow, sparse)...");
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

    const variantIds = collectVariantIds(characters);

    stagingRoot = await mkdtemp(path.join(OLD_ASSETS_DIR, ".webp-sync-"));
    const stagedAvatars = path.join(stagingRoot, "avatars");
    await mkdir(stagedAvatars);

    console.log(`→ Converting ${variantIds.size} variant images to lossless WebP...`);
    await stageVariantImages(variantIds, stagedAvatars);
    const newEntries = collectNewEntries(arcanists, existingBaseIds, stagedAvatars);

    let hasStagedVertin = false;
    if (existsSync(VERTIN_PNG)) {
      await convertPngToLosslessWebp(
        VERTIN_PNG,
        path.join(stagingRoot, "vertin_question.webp")
      );
      hasStagedVertin = true;
    } else if (!existsSync(VERTIN_WEBP)) {
      throw new Error("Neither vertin_question.png nor vertin_question.webp exists");
    }

    console.log("→ Replacing validated production assets...");
    await replaceStagedAssets(stagingRoot, hasStagedVertin);
    let autoAdded = 0;
    for (const entry of newEntries.ready) {
      const defaultVariant = `${entry.id}01`;
      characters.push({
        id: defaultVariant,
        name: entry.name,
        baseId: entry.id,
        releaseOrder: 0,
        enabled: true,
        skins: buildSkins(entry),
        defaultVariant,
        stage: "pending-names",
        isReleased: false,
      });
      autoAdded++;
    }

    const ordered = recalculateReleaseOrder(characters);
    for (const character of ordered) delete character._kbId;
    writeFileSync(DATA_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf-8");

    let wiped = 0;
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

    console.log("\n=== Summary ===");
    console.log(`Wiped: ${wiped} old directories`);
    console.log(`Converted: ${variantIds.size} images`);
    console.log(`Auto-added: ${autoAdded} new characters`);
    console.log(`Pending: ${newEntries.pending.length}`);
    if (newEntries.pending.length > 0) {
      writeFileSync(
        PENDING_FILE,
        JSON.stringify(newEntries.pending, null, 2) + "\n",
        "utf-8"
      );
      console.log(`  Pending list written: ${PENDING_FILE}`);
    }
    if (autoAdded === 0 && newEntries.pending.length === 0) {
      console.log("  No new characters detected");
    }

    console.log(`\n✓ Assets in: ${AVATARS_DIR}`);
  } finally {
    if (stagingRoot) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
    try {
      run("rm", ["-rf", TEMP_DIR]);
    } catch {
      console.warn("  Failed to remove temporary clone");
    }
  }
}

void main().catch((error) => {
  console.error("sync-assets failed:", error);
  process.exitCode = 1;
});
