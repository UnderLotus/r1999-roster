import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

const WEBP_OPTIONS = { lossless: true, effort: 6 } as const;

interface DecodedImage {
  data: Buffer;
  width: number;
  height: number;
}

async function decodeRgba(filePath: string): Promise<DecodedImage> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4) {
    throw new Error(`Expected RGBA image data, got ${info.channels} channels: ${filePath}`);
  }

  return { data, width: info.width, height: info.height };
}

/**
 * Verify that two images have identical visible RGBA pixels.
 * RGB in fully transparent pixels is intentionally ignored.
 */
export async function validateImageParity(
  sourcePath: string,
  outputPath: string
): Promise<void> {
  const [source, output] = await Promise.all([
    decodeRgba(sourcePath),
    decodeRgba(outputPath),
  ]);

  if (source.width !== output.width || source.height !== output.height) {
    throw new Error(
      `Image dimensions differ: ${source.width}x${source.height} vs ` +
        `${output.width}x${output.height}`
    );
  }

  for (let offset = 0; offset < source.data.length; offset += 4) {
    const alpha = source.data[offset + 3];
    const outputAlpha = output.data[offset + 3];
    if (alpha !== outputAlpha) {
      throw new Error(`Image alpha differs at pixel ${offset / 4}`);
    }

    if (alpha === 0) continue;

    for (let channel = 0; channel < 3; channel++) {
      if (source.data[offset + channel] !== output.data[offset + channel]) {
        throw new Error(
          `Image RGB differs at pixel ${offset / 4}, channel ${channel}`
        );
      }
    }
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

/** Replace a destination after validation, retaining it if replacement fails. */
async function replaceValidatedFile(
  stagingPath: string,
  outputPath: string
): Promise<void> {
  try {
    await rename(stagingPath, outputPath);
    return;
  } catch (error) {
    if (!new Set(["EEXIST", "EPERM", "ENOTEMPTY"]).has(errorCode(error) ?? "")) {
      throw error;
    }
  }

  const backupPath = `${outputPath}.backup-${randomUUID()}`;
  await rename(outputPath, backupPath);
  try {
    await rename(stagingPath, outputPath);
    await rm(backupPath, { force: true });
  } catch (error) {
    try {
      await rename(backupPath, outputPath);
    } catch {
      // Preserve the original replacement error; the backup path is reported by the OS if restore also fails.
    }
    throw error;
  }
}

/** Convert a PNG to lossless WebP and replace the destination only after parity passes. */
export async function convertPngToLosslessWebp(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const source = path.resolve(inputPath);
  const destination = path.resolve(outputPath);
  if (source === destination) {
    throw new Error("Input and output paths must differ");
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const stagingPath = `${destination}.tmp-${randomUUID()}`;

  try {
    await sharp(source)
      .ensureAlpha()
      .webp(WEBP_OPTIONS)
      .toFile(stagingPath);
    await validateImageParity(source, stagingPath);
    await replaceValidatedFile(stagingPath, destination);
  } finally {
    await rm(stagingPath, { force: true });
  }
}
