import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

import { validateSupplementWebp } from "./uttu-supplement";
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

async function testConverterAndSupplementGate(): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "r1999-webp-test-"));
  try {
    const sourcePath = path.join(directory, "fixture.png");
    const outputPath = path.join(directory, "fixture.webp");
    await writePng(sourcePath, pixels);

    await convertPngToLosslessWebp(sourcePath, outputPath);
    assert.deepEqual((await readdir(directory)).sort(), ["fixture.png", "fixture.webp"]);

    // Supplement WebP gate: lossless + alpha passes; lossy, disguised PNG, and no-alpha reject.
    assert.deepEqual(
      await validateSupplementWebp(outputPath),
      { width, height },
      "lossless supplemental WebP passes decoded dimension/alpha validation"
    );

    const lossyPath = path.join(directory, "lossy.webp");
    await sharp(pixels, { raw: { width, height, channels: 4 } })
      .webp({ lossless: false, quality: 80 })
      .toFile(lossyPath);
    await assert.rejects(() => validateSupplementWebp(lossyPath), /not a lossless WebP/);

    const disguisedPngPath = path.join(directory, "disguised.webp");
    await writePng(disguisedPngPath, pixels);
    await assert.rejects(() => validateSupplementWebp(disguisedPngPath), /not a lossless WebP/);

    const noAlphaPath = path.join(directory, "no-alpha.webp");
    await sharp(Buffer.from([255, 0, 0]), {
      raw: { width: 1, height: 1, channels: 3 },
    })
      .webp({ lossless: true, effort: 6 })
      .toFile(noAlphaPath);
    await assert.rejects(() => validateSupplementWebp(noAlphaPath), /no alpha channel/);

    // Parity validation: visible RGB diff, alpha diff, and size diff reject;
    // RGB differences in fully transparent (alpha === 0) pixels are ignored.
    const rgbDiffPixels = Buffer.from(pixels);
    rgbDiffPixels[0] = 254;
    const rgbDiffPath = path.join(directory, "rgb-diff.webp");
    await writeWebp(rgbDiffPath, rgbDiffPixels);
    await assert.rejects(() => validateImageParity(sourcePath, rgbDiffPath), /Image RGB differs/);

    const alphaDiffPixels = Buffer.from(pixels);
    alphaDiffPixels[7] = 127;
    const alphaDiffPath = path.join(directory, "alpha-diff.webp");
    await writeWebp(alphaDiffPath, alphaDiffPixels);
    await assert.rejects(
      () => validateImageParity(sourcePath, alphaDiffPath),
      /Image alpha differs/
    );

    const transparentRgbDiff = Buffer.from(pixels);
    transparentRgbDiff[8] = 1; // pixel 2 has alpha === 0
    transparentRgbDiff[9] = 2;
    transparentRgbDiff[10] = 3;
    const transparentDiffPath = path.join(directory, "transparent-rgb-diff.webp");
    await writeWebp(transparentDiffPath, transparentRgbDiff);
    await validateImageParity(sourcePath, transparentDiffPath);

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

    // Failed conversion preserves existing output bytes and leaves no .tmp- staging files.
    const invalidSourcePath = path.join(directory, "invalid.png");
    const preservedOutputPath = path.join(directory, "preserved.webp");
    const preservedBytes = Buffer.from("existing output");
    await writeFile(invalidSourcePath, "not an image");
    await writeFile(preservedOutputPath, preservedBytes);
    await assert.rejects(() =>
      convertPngToLosslessWebp(invalidSourcePath, preservedOutputPath)
    );
    assert.deepEqual(await readFile(preservedOutputPath), preservedBytes);
    assert.equal(
      (await readdir(directory)).some((file) => file.includes(".tmp-")),
      false,
      "staging files are removed after failure"
    );

    console.log("Lossless WebP converter and supplement gate checks passed.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
  const BATCH_SIZE = 16;
  for (let offset = 0; offset < avatarFiles.length; offset += BATCH_SIZE) {
    const sizes = await Promise.all(
      avatarFiles.slice(offset, offset + BATCH_SIZE).map(async (file) => {
        const filePath = path.join(avatarsDir, file);
        const metadata = await sharp(filePath).metadata();
        assert.equal(metadata.format, "webp", `${file} is WebP`);
        await sharp(filePath).raw().toBuffer();
        return (await stat(filePath)).size;
      })
    );
    for (const size of sizes) totalBytes += size;
  }

  const vertin = await sharp(path.join(root, "public/assets/vertin_question.webp")).metadata();
  assert.equal(vertin.format, "webp", "Vertin empty-state image is WebP");
  assert.equal(vertin.hasAlpha, true, "Vertin retains alpha");

  for (const file of ["favicon.png", "favicon-32.png"]) {
    const metadata = await sharp(path.join(root, "public", file)).metadata();
    assert.equal(metadata.format, "png", `${file} remains PNG`);
  }

  console.log(
    `Asset integrity passed: ${avatarFiles.length} avatars, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`
  );
}

await testConverterAndSupplementGate();
await testRepositoryAssets();
