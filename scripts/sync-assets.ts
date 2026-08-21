/**
 * Phase 3 — 同步官方素材 + 新角色偵測。
 *
 * 1. 增量刷新官方 CN asset repo 暫存 clone（headicon_middle/ + mappings/；僅在無法增量 pull 時重新 shallow-clone）
 * 2. 以 mappings/ArcanistMap.json 刷新 scripts/data/ArcanistMap.json（新角色偵測基準）
 * 3. 以 PNG sha256 快取重用未變更的 lossless WebP，只轉換新增／變更的圖
 * 4. 只有整批驗證成功後才替換 avatars/，避免部分更新；hash 快取在替換成功後才寫回
 * 5. 偵測 ArcanistMap 中的新角色，全部 variant 頭貼齊備就自動加入 characters.json
 *
 * 執行：npm run sync
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
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
const HASH_CACHE_FILE = path.join(__dirname, "data/avatar-hash-cache.json");
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
  existingBaseIds: ReadonlySet<number>
): { ready: ArcanistEntryFull[]; pending: PendingCharacter[] } {
  const ready: ArcanistEntryFull[] = [];
  const pending: PendingCharacter[] = [];

  for (const entry of arcanists) {
    if (existingBaseIds.has(entry.id)) continue;
    const defaultVariantId = `${entry.id}01`;
    const missing = buildSkins(entry)
      .map((skin) => skin.variantId)
      .filter((variantId) => !existsSync(path.join(SOURCE_DIR, `${variantId}.png`)));
    if (missing.length === 0) {
      ready.push(entry);
    } else {
      pending.push({
        baseId: entry.id,
        variantId: defaultVariantId,
        name: entry.name,
        nameEng: entry.nameEng,
        reason: `headicon missing in CN asset repo: ${missing.join(", ")}`,
      });
    }
  }

  return { ready, pending };
}

interface AvatarHashEntry {
  png: string;
  webp: string;
}

type AvatarHashCache = Record<string, AvatarHashEntry>;

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function loadHashCache(): AvatarHashCache {
  if (!existsSync(HASH_CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(HASH_CACHE_FILE, "utf-8")) as AvatarHashCache;
  } catch {
    return {};
  }
}

async function stageVariantImages(
  variantIds: ReadonlySet<string>,
  stagingDir: string,
  hashCache: AvatarHashCache
): Promise<{ cache: AvatarHashCache; reused: number; converted: number }> {
  const missing = [...variantIds].filter(
    (variantId) => !existsSync(path.join(SOURCE_DIR, `${variantId}.png`))
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.length} expected source image(s): ${missing.join(", ")}`
    );
  }

  const nextCache: AvatarHashCache = {};
  let reused = 0;

  for (const variantId of variantIds) {
    const sourcePng = path.join(SOURCE_DIR, `${variantId}.png`);
    const stagedWebp = path.join(stagingDir, `${variantId}.webp`);
    const prodWebp = path.join(AVATARS_DIR, `${variantId}.webp`);
    const pngHash = sha256(sourcePng);
    const cached = hashCache[variantId];

    // PNG 未變且現有 webp 校驗一致 → 直接重用，免重轉
    if (
      cached?.png === pngHash &&
      existsSync(prodWebp) &&
      sha256(prodWebp) === cached.webp
    ) {
      await copyFile(prodWebp, stagedWebp);
      nextCache[variantId] = cached;
      reused++;
    } else {
      await convertPngToLosslessWebp(sourcePng, stagedWebp);
      nextCache[variantId] = { png: pngHash, webp: sha256(stagedWebp) };
    }
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

  return { cache: nextCache, reused, converted: variantIds.size - reused };
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

function readDeprecatedBaseIds(): Set<number> {
  const file = path.join(__dirname, "data", "deprecated-characters.json");
  if (!existsSync(file)) return new Set();
  return new Set(
    (JSON.parse(readFileSync(file, "utf-8")) as { baseId: number }[]).map(
      (entry) => entry.baseId
    )
  );
}

const SPARSE_DIRS = ["singlebg/headicon_middle", "mappings"] as const;

function refreshAssetRepo(): void {
  if (existsSync(path.join(TEMP_DIR, ".git"))) {
    try {
      run("git", ["pull", "--depth", "1", "--ff-only"], TEMP_DIR);
      run("git", ["sparse-checkout", "set", ...SPARSE_DIRS], TEMP_DIR);
      console.log("  ✓ incremental pull");
      return;
    } catch {
      console.warn("  Incremental pull failed — rebuilding with a fresh clone");
      run("rm", ["-rf", TEMP_DIR]);
    }
  }

  run("git", [
    "clone",
    "--depth", "1",
    "--filter=blob:none",
    "--sparse",
    ASSET_REPO,
    TEMP_DIR,
  ]);
  run("git", ["sparse-checkout", "set", ...SPARSE_DIRS], TEMP_DIR);
  run("git", ["checkout"], TEMP_DIR);
  console.log("  ✓ fresh shallow clone");
}

async function main(): Promise<void> {
  console.log("Phase 3: sync-assets\n");

  if (!existsSync(DATA_FILE)) {
    throw new Error(
      `${DATA_FILE} not found — run Phase 2 first (npm run build:characters)`
    );
  }

  const characters = loadJSON<Character[]>(DATA_FILE);
  const existingBaseIds = new Set(characters.map((character) => character.baseId));

  console.log(`Characters: ${characters.length}`);
  console.log(`Current variant images: ${collectVariantIds(characters).size}`);

  let stagingRoot: string | undefined;
  try {
    console.log("→ Refreshing official asset repo clone...");
    refreshAssetRepo();

    // Refresh local ArcanistMap from the fresh clone (authority for character
    // existence) so new CN characters are detected without a manual copy step.
    const upstreamMapPath = path.join(TEMP_DIR, "mappings", "ArcanistMap.json");
    if (!existsSync(upstreamMapPath)) {
      throw new Error(`${upstreamMapPath} not found in CN asset repo`);
    }
    const arcanists = JSON.parse(
      readFileSync(upstreamMapPath, "utf-8")
    ) as ArcanistEntryFull[];
    writeFileSync(ARCANIST_MAP, JSON.stringify(arcanists, null, 2) + "\n", "utf-8");
    console.log(`→ Refreshed ArcanistMap.json (${arcanists.length} entries)`);

    const deprecatedBaseIds = readDeprecatedBaseIds();

    const variantIds = collectVariantIds(characters);

    stagingRoot = await mkdtemp(path.join(OLD_ASSETS_DIR, ".webp-sync-"));
    const stagedAvatars = path.join(stagingRoot, "avatars");
    await mkdir(stagedAvatars);

    const newEntries = collectNewEntries(
      arcanists.filter((entry) => !deprecatedBaseIds.has(entry.id)),
      existingBaseIds
    );
    const newVariantIds = new Set(
      newEntries.ready.flatMap((entry) =>
        buildSkins(entry).map((skin) => skin.variantId)
      )
    );
    const allVariantIds = new Set([...variantIds, ...newVariantIds]);

    const staged = await stageVariantImages(allVariantIds, stagedAvatars, loadHashCache());
    console.log(
      `→ Staged ${allVariantIds.size} avatars: ${staged.reused} reused, ${staged.converted} converted (${newVariantIds.size} from new characters)`
    );

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
    writeFileSync(
      HASH_CACHE_FILE,
      JSON.stringify(staged.cache, null, 2) + "\n",
      "utf-8"
    );
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
    console.log(`Avatars: ${staged.reused} reused, ${staged.converted} converted`);
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
    // TEMP_DIR 的 asset repo clone 刻意保留，供下次執行增量 pull。
  }
}

void main().catch((error) => {
  console.error("sync-assets failed:", error);
  process.exitCode = 1;
});
