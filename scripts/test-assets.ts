import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import {
  convertPngToLosslessWebp,
  validateImageParity,
} from "./webp-converter";

const width = 3;
const height = 2;
const pixels = Buffer.from([
  255, 0, 0, 255, 10, 20, 30, 128, 200, 100, 50, 0,
  0, 255, 0, 255, 5, 6, 7, 64, 8, 9, 10, 0,
]);

async function writePng(filePath: string, data: Buffer): Promise<void> {
  await sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toFile(filePath);
}

async function writeWebp(filePath: string, data: Buffer): Promise<void> {
  await sharp(data, { raw: { width, height, channels: 4 } })
    .webp({ lossless: true, effort: 6 })
    .toFile(filePath);
}

async function testRepositoryAssets(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const characters = JSON.parse(
    await readFile(path.join(root, "src/data/characters.json"), "utf8")
  ) as Array<{ skins: Array<{ variantId: string }> }>;
  const expectedFiles = new Set(
    characters.flatMap((character) =>
      character.skins.map((skin) => `${skin.variantId}.webp`)
    )
  );
  const avatarsDir = path.join(root, "public/assets/characters/avatars");
  const avatarFiles = await readdir(avatarsDir);
  assert.deepEqual(
    [...avatarFiles].sort(),
    [...expectedFiles].sort(),
    "avatar files exactly cover character variants without stale files"
  );

  let totalBytes = 0;
  for (const file of avatarFiles) {
    const filePath = path.join(avatarsDir, file);
    const metadata = await sharp(filePath).metadata();
    assert.equal(metadata.format, "webp", `${file} is WebP`);
    assert.equal(metadata.height, 524, `${file} has expected height`);
    assert.ok(
      metadata.width === 224 || metadata.width === 228,
      `${file} has expected width`
    );
    const decoded = await sharp(filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.channels, 4, `${file} decodes as RGBA`);
    let alphaMin = 255;
    let alphaMax = 0;
    for (let offset = 3; offset < decoded.data.length; offset += 4) {
      alphaMin = Math.min(alphaMin, decoded.data[offset]);
      alphaMax = Math.max(alphaMax, decoded.data[offset]);
    }
    assert.ok(
      metadata.hasAlpha || (alphaMin === 255 && alphaMax === 255),
      `${file} retains alpha semantics`
    );
    totalBytes += (await stat(filePath)).size;
  }

  const maxBytes = 36 * 1024 * 1024;
  const baselineBytes = 57.38 * 1024 * 1024;
  assert.ok(totalBytes <= maxBytes, `avatars are under 36 MiB: ${totalBytes}`);
  assert.ok(
    totalBytes <= baselineBytes * 0.65,
    `avatars save at least 35%: ${totalBytes} bytes`
  );

  const vertin = await sharp(path.join(root, "public/assets/vertin_question.webp")).metadata();
  assert.equal(vertin.format, "webp", "Vertin empty-state image is WebP");
  assert.equal(vertin.width, 400, "Vertin has expected width");
  assert.equal(vertin.height, 400, "Vertin has expected height");
  assert.equal(vertin.hasAlpha, true, "Vertin retains alpha");

  for (const file of ["favicon.png", "favicon-32.png"]) {
    const metadata = await sharp(path.join(root, "public", file)).metadata();
    assert.equal(metadata.format, "png", `${file} remains PNG`);
  }

  console.log(
    `Asset integrity passed: ${avatarFiles.length} avatars, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`
  );
}

const directory = await mkdtemp(path.join(os.tmpdir(), "r1999-webp-test-"));
try {
  const sourcePath = path.join(directory, "fixture.png");
  const outputPath = path.join(directory, "fixture.webp");
  await writePng(sourcePath, pixels);

  await convertPngToLosslessWebp(sourcePath, outputPath);
  await validateImageParity(sourcePath, outputPath);
  const outputMetadata = await sharp(outputPath).metadata();
  assert.equal(outputMetadata.width, width);
  assert.equal(outputMetadata.height, height);
  assert.equal(outputMetadata.hasAlpha, true);

  const filesAfterSuccess = await readdir(directory);
  assert.deepEqual(filesAfterSuccess.sort(), ["fixture.png", "fixture.webp"]);

  const mismatchedPixels = Buffer.from(pixels);
  mismatchedPixels[0] = 254;
  const mismatchedPath = path.join(directory, "mismatched.webp");
  await writeWebp(mismatchedPath, mismatchedPixels);
  await assert.rejects(
    () => validateImageParity(sourcePath, mismatchedPath),
    /Image RGB differs/
  );

  const wrongSizePath = path.join(directory, "wrong-size.webp");
  await sharp(Buffer.from([1, 2, 3, 255]), {
    raw: { width: 1, height: 1, channels: 4 },
  })
    .webp({ lossless: true, effort: 6 })
    .toFile(wrongSizePath);
  await assert.rejects(
    () => validateImageParity(sourcePath, wrongSizePath),
    /Image dimensions differ/
  );

  const invalidSourcePath = path.join(directory, "invalid.png");
  const preservedOutputPath = path.join(directory, "preserved.webp");
  const preservedBytes = Buffer.from("existing output");
  await writeFile(invalidSourcePath, "not an image");
  await writeFile(preservedOutputPath, preservedBytes);
  await assert.rejects(() =>
    convertPngToLosslessWebp(invalidSourcePath, preservedOutputPath)
  );
  assert.deepEqual(await readFile(preservedOutputPath), preservedBytes);

  const filesAfterFailure = await readdir(directory);
  assert.equal(
    filesAfterFailure.some((file) => file.includes(".tmp-")),
    false,
    "staging files are removed after failure"
  );

  console.log("All lossless WebP converter tests passed.");
} finally {
  await rm(directory, { recursive: true, force: true });
}

await testRepositoryAssets();
