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
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Character } from "./types";
import {
  cloneCharacterRecord,
  mapCnCharacterMetadata,
  planCnIngestion,
  type CnDiagnosticCandidate,
  type CnDeprecatedEntry,
  type CnIngestionPlan,
  type ArcanistEntryFull,
} from "./cn-ingestion";
import { recalculateReleaseOrder } from "./recalculate-order";
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

function readDeprecatedEntries(): CnDeprecatedEntry[] {
  const file = path.join(__dirname, "data", "deprecated-characters.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf-8")) as CnDeprecatedEntry[];
}

function collectImageIds(directory: string, extension: string): Set<string> {
  if (!existsSync(directory)) return new Set();
  return new Set(
    readdirSync(directory)
      .filter((file) => file.endsWith(extension))
      .map((file) => file.slice(0, -extension.length))
  );
}

/**
 * Warning-only adapter heuristic. It never assigns ownership or adds a
 * Character; it only identifies numeric player-like filenames that the fresh
 * mapping did not explain. NPC inventories use other numeric ranges and stay
 * silent without a hardcoded snapshot allowlist.
 */
export function collectMappingLagCandidates(
  sourceImageIds: ReadonlySet<string>,
  mappedVariantIds: ReadonlySet<string>,
  deprecatedVariantIds: ReadonlySet<string> = new Set()
): CnDiagnosticCandidate[] {
  return [...sourceImageIds]
    .filter(
      (variantId) =>
        !mappedVariantIds.has(variantId) &&
        !deprecatedVariantIds.has(variantId) &&
        /^3\d{5,7}$/.test(variantId)
    )
    .sort((a, b) => a.localeCompare(b))
    .map((variantId) => ({
      variantId,
      code: "unmapped-player-like-headicon" as const,
      message: `headicon ${variantId} looks player-like but is absent from ArcanistMap; skipped`,
    }));
}

export function reportSyncDiagnostics(
  diagnostics: CnIngestionPlan["diagnostics"],
  warn: (message: string) => void = console.warn
): void {
  for (const diagnostic of diagnostics) {
    warn(`⚠ ${diagnostic.message} (nonblocking)`);
  }
}

/** Apply only sync's current roster/pending projection; existing reconciliation belongs to build. */
export function applySyncPlan(
  characters: Character[],
  plan: CnIngestionPlan
): void {
  for (const character of plan.sync.readyNewCharacters) {
    characters.push(cloneCharacterRecord(character));
  }
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
  console.log(`Characters: ${characters.length}`);
  console.log(
    `Current variant images: ${new Set(
      characters.flatMap((character) => character.skins.map((skin) => skin.variantId))
    ).size}`
  );

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

    const deprecatedEntries = readDeprecatedEntries();
    const sourceImageIds = collectImageIds(SOURCE_DIR, ".png");
    const localImageIds = collectImageIds(AVATARS_DIR, ".webp");
    const mappedCharacters = arcanists.map(mapCnCharacterMetadata);
    const mappedVariantIds = new Set(
      mappedCharacters.flatMap((mapped) => mapped.skins.map((skin) => skin.variantId))
    );
    const deprecatedVariantIds = new Set(
      deprecatedEntries.flatMap((entry) =>
        entry.variantId === undefined ? [] : [entry.variantId]
      )
    );
    const plan = planCnIngestion({
      currentCharacters: characters,
      mappedCharacters,
      sourceImageIds,
      localImageIds,
      deprecatedEntries,
      diagnosticCandidates: collectMappingLagCandidates(
        sourceImageIds,
        mappedVariantIds,
        deprecatedVariantIds
      ),
    });
    reportSyncDiagnostics(plan.diagnostics);
    console.log(
      `→ CN plan: ${plan.summary.mappedCharacterCount} mapped, ${plan.summary.diagnosticCount} nonblocking warning(s)`
    );

    stagingRoot = await mkdtemp(path.join(OLD_ASSETS_DIR, ".webp-sync-"));
    const stagedAvatars = path.join(stagingRoot, "avatars");
    await mkdir(stagedAvatars);

    const newVariantIds = new Set(
      plan.sync.readyNewCharacters.flatMap((character) =>
        character.skins.map((skin) => skin.variantId)
      )
    );
    // Stage fresh-map variants for existing characters before build:characters
    // reconciles the mapping into characters.json. Pending new Characters stay
    // out of this set so sync keeps its historical partial-progress behavior.
    const stagedVariantIds = new Set(plan.stagedVariantIds);

    const staged = await stageVariantImages(
      stagedVariantIds,
      stagedAvatars,
      loadHashCache()
    );
    console.log(
      `→ Staged ${stagedVariantIds.size} avatars: ${staged.reused} reused, ${staged.converted} converted (${newVariantIds.size} from new characters)`
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
    applySyncPlan(characters, plan);
    const autoAdded = plan.sync.readyNewCharacters.length;

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
    console.log(`Pending: ${plan.sync.pendingNewCharacters.length}`);
    console.log(`Deprecated skips: ${plan.deprecatedSkips.length}`);
    // 每次成功更新都寫完整 pending snapshot（含空清單），
    // 避免上一輪的 pending 條目在角色全部 ready 後殘留。
    writeFileSync(
      PENDING_FILE,
      JSON.stringify(plan.sync.pendingNewCharacters, null, 2) + "\n",
      "utf-8"
    );
    if (plan.sync.pendingNewCharacters.length > 0) {
      console.log(`  Pending list written: ${PENDING_FILE}`);
    }
    if (autoAdded === 0 && plan.sync.pendingNewCharacters.length === 0) {
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

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMainModule()) {
  void main().catch((error) => {
    console.error("sync-assets failed:", error);
    process.exitCode = 1;
  });
}
