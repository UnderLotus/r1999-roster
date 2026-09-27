import { characterCatalog } from "../data/characters";
import type { BoxState, SkinMode } from "../domain/box";
import type { VariantIdentityCatalog } from "../domain/variant-identity";
import type { CharacterState, PortrayLevel } from "../types/character";

/**
 * URL share token format.
 *
 * v2 keeps the existing header and owned-character entries, but stores every
 * custom Variant as its complete canonical numeric Variant ID. Ownership is
 * always resolved through the Character catalog.
 *
 * v1 decoding is deliberately isolated in the legacy adapter below. Its
 * suffix reconstruction exists only to preserve historical URLs.
 */
export type SharePayload = BoxState;

export interface ShareEncodeInput {
  characters: Record<string, CharacterState>;
  activeVariant: Record<string, string>;
  customVariants: Record<string, true>;
  defaultSkinMode: SkinMode;
  showFutureSight: boolean;
}

export interface RawSharePayload {
  charEntries: Array<[number, number]>;
  skinEntries: Array<[number, string]>;
  defaultSkinMode: SkinMode;
  showFutureSight: boolean;
}

const V1_VERSION = 1;
const V2_VERSION = 2;
const BASE_ID_BITS = 14;
const VARIANT_ID_BITS = 27;
const COUNT_BITS = 8;
const MAX_BASE_ID = 2 ** BASE_ID_BITS - 1;
const MAX_VARIANT_ID = 2 ** VARIANT_ID_BITS - 1;
const MAX_COUNT = 2 ** COUNT_BITS - 1;

/* ---------- base64url (RFC 4648 §5, without padding) ---------- */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBase64Url(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < data.length ? data[i + 1] : 0;
    const b2 = i + 2 < data.length ? data[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    if (i + 1 < data.length) {
      out += B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)];
    }
    if (i + 2 < data.length) {
      out += B64_ALPHABET[b2 & 63];
    }
  }
  return out;
}

function fromBase64Url(token: string): Uint8Array | null {
  if (token.length === 0 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  const index = new Map([...B64_ALPHABET].map((ch, i) => [ch, i]));
  const bytes: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of token) {
    const value = index.get(ch);
    if (value === undefined) return null;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/* ---------- bit reader ---------- */

class BitReader {
  private pos = 0;

  constructor(private readonly bits: boolean[]) {}

  get position(): number {
    return this.pos;
  }

  /** Read n bits; structural shortage rejects the complete token. */
  get(n: number): number | null {
    if (this.pos + n > this.bits.length) return null;
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = value * 2 + (this.bits[this.pos++] ? 1 : 0);
    }
    return value;
  }
}

function bitsFromBytes(data: Uint8Array): boolean[] {
  const bits: boolean[] = [];
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) === 1);
  }
  return bits;
}

function hasOnlyZeroPadding(reader: BitReader, bits: boolean[]): boolean {
  if (bits.length % 8 !== 0) return false;
  if (Math.ceil(reader.position / 8) !== bits.length / 8) return false;
  for (let i = reader.position; i < bits.length; i++) {
    if (bits[i]) return false;
  }
  return true;
}

/* ---------- catalog and wire validation ---------- */

function requireWireInteger(
  value: number,
  max: number,
  label: string
): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${label} ${value} cannot be represented in the share token`);
  }
}

function canonicalWireVariantId(variantId: string): number | null {
  if (!/^(?:0|[1-9]\d*)$/.test(variantId)) return null;
  const numeric = Number(variantId);
  if (!Number.isSafeInteger(numeric) || numeric > MAX_VARIANT_ID) return null;
  if (String(numeric) !== variantId) return null;
  return numeric;
}

function normalizePortray(value: number): PortrayLevel {
  if (!Number.isFinite(value) || !Number.isInteger(value)) return 0;
  return Math.min(5, Math.max(0, value)) as PortrayLevel;
}

/* ---------- v2 encoding ---------- */

export function encodeShareCode(
  input: ShareEncodeInput,
  identity: VariantIdentityCatalog = characterCatalog
): string {
  const owned: Array<[number, number]> = [];
  const ownedIds = new Set<string>();

  for (const [id, state] of Object.entries(input.characters)) {
    if (!state?.owned) continue;
    const character = identity.getCharacterById(id);
    if (!character) continue;
    requireWireInteger(character.baseId, MAX_BASE_ID, `Character ${id} baseId`);
    owned.push([character.baseId, normalizePortray(state.portray)]);
    ownedIds.add(id);
  }
  if (owned.length > MAX_COUNT) {
    throw new RangeError(`Character count ${owned.length} cannot be represented in the share token`);
  }
  owned.sort((a, b) => a[0] - b[0]);

  const skins: Array<[number, number]> = [];
  for (const id of Object.keys(input.customVariants)) {
    const character = identity.getCharacterById(id);
    const variantId = input.activeVariant[id];
    if (!character || !ownedIds.has(id) || !variantId) continue;
    if (!identity.ownsVariant(id, variantId)) continue;

    requireWireInteger(character.baseId, MAX_BASE_ID, `Character ${id} baseId`);
    const variantNumber = canonicalWireVariantId(variantId);
    if (variantNumber === null) {
      throw new RangeError(
        `Variant ${variantId} cannot be represented as a canonical ${VARIANT_ID_BITS}-bit numeric identity`
      );
    }
    skins.push([character.baseId, variantNumber]);
  }
  if (skins.length > MAX_COUNT) {
    throw new RangeError(`Skin count ${skins.length} cannot be represented in the share token`);
  }
  skins.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const bits: boolean[] = [];
  const put = (value: number, width: number): void => {
    requireWireInteger(value, 2 ** width - 1, `Value ${value}`);
    for (let i = width - 1; i >= 0; i--) {
      bits.push(Math.floor(value / 2 ** i) % 2 === 1);
    }
  };

  put(V2_VERSION, 4);
  put(input.defaultSkinMode === "insight" ? 1 : 0, 1);
  put(input.showFutureSight ? 1 : 0, 1);
  put(skins.length > 0 ? 1 : 0, 1);
  put(owned.length, COUNT_BITS);
  for (const [baseId, portray] of owned) {
    put(baseId, BASE_ID_BITS);
    put(portray, 3);
  }
  if (skins.length > 0) {
    put(skins.length, COUNT_BITS);
    for (const [baseId, variantNumber] of skins) {
      put(baseId, BASE_ID_BITS);
      put(variantNumber, VARIANT_ID_BITS);
    }
  }

  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return toBase64Url(bytes);
}

/* ---------- shared sanitization ---------- */

/**
 * Sanitize already-decoded v2 entries against the explicit Character catalog.
 * Unknown Characters and wrong-owner Variants are discarded independently.
 */
export function sanitizeSharePayload(
  raw: RawSharePayload,
  identity: VariantIdentityCatalog = characterCatalog
): SharePayload {
  const characters: Record<string, CharacterState> = {};
  const seenCharacters = new Set<string>();
  for (const [baseId, portray] of raw.charEntries) {
    const character = identity.getCharacterByBaseId(baseId);
    if (!character || seenCharacters.has(character.id)) continue;
    seenCharacters.add(character.id);
    characters[character.id] = {
      owned: true,
      portray: normalizePortray(portray),
    };
  }

  const activeVariant: Record<string, string> = {};
  const customVariants: Record<string, true> = {};
  for (const [baseId, variantId] of raw.skinEntries) {
    if (typeof variantId !== "string") continue;
    const character = identity.getCharacterByBaseId(baseId);
    if (!character || !characters[character.id]) continue;
    if (!identity.ownsVariant(character.id, variantId)) continue;
    if (activeVariant[character.id] !== undefined) continue;
    activeVariant[character.id] = variantId;
    customVariants[character.id] = true;
  }

  return {
    characters,
    activeVariant,
    customVariants,
    defaultSkinMode: raw.defaultSkinMode === "insight" ? "insight" : "initial",
    showFutureSight: raw.showFutureSight === true,
  };
}

/* ---------- legacy v1 decoder adapter ---------- */

/**
 * Reconstruct the historical six-digit ID only while decoding a v1 suffix.
 * In particular, suffix 01 resolves to {base}01 and never to an eight-digit
 * Variant that happens to end in 01.
 */
function legacyVariantIdFromSuffix(
  identity: VariantIdentityCatalog,
  baseId: number,
  suffix: number
): string | null {
  if (
    !Number.isSafeInteger(baseId) ||
    baseId < 0 ||
    baseId > 9999 ||
    !Number.isSafeInteger(suffix) ||
    suffix < 1 ||
    suffix > 99
  ) {
    return null;
  }
  const character = identity.getCharacterByBaseId(baseId);
  if (!character) return null;
  const historicalVariantId = `${String(baseId).padStart(4, "0")}${String(suffix).padStart(2, "0")}`;
  return identity.ownsVariant(character.id, historicalVariantId)
    ? historicalVariantId
    : null;
}

interface DecodedHeader {
  skinModeBit: number;
  futureBit: number;
  hasSkins: number;
  charCount: number;
}

function readHeader(reader: BitReader): DecodedHeader | null {
  const skinModeBit = reader.get(1);
  const futureBit = reader.get(1);
  const hasSkins = reader.get(1);
  const charCount = reader.get(COUNT_BITS);
  if (
    skinModeBit === null ||
    futureBit === null ||
    hasSkins === null ||
    charCount === null
  ) {
    return null;
  }
  return { skinModeBit, futureBit, hasSkins, charCount };
}

function readCharacterEntries(
  reader: BitReader,
  charCount: number
): Array<[number, number]> | null {
  const entries: Array<[number, number]> = [];
  for (let i = 0; i < charCount; i++) {
    const baseId = reader.get(BASE_ID_BITS);
    const portray = reader.get(3);
    if (baseId === null || portray === null) return null;
    entries.push([baseId, portray]);
  }
  return entries;
}

function decodeV1(
  reader: BitReader,
  bits: boolean[],
  identity: VariantIdentityCatalog
): SharePayload | null {
  const header = readHeader(reader);
  if (!header) return null;
  const charEntries = readCharacterEntries(reader, header.charCount);
  if (!charEntries) return null;

  const skinEntries: Array<[number, string]> = [];
  if (header.hasSkins === 1) {
    const skinCount = reader.get(COUNT_BITS);
    if (skinCount === null) return null;
    for (let i = 0; i < skinCount; i++) {
      const baseId = reader.get(BASE_ID_BITS);
      const suffix = reader.get(7);
      if (baseId === null || suffix === null) return null;
      const variantId = legacyVariantIdFromSuffix(identity, baseId, suffix);
      if (variantId !== null) skinEntries.push([baseId, variantId]);
    }
  }

  if (!hasOnlyZeroPadding(reader, bits)) return null;
  return sanitizeSharePayload(
    {
      charEntries,
      skinEntries,
      defaultSkinMode: header.skinModeBit === 1 ? "insight" : "initial",
      showFutureSight: header.futureBit === 1,
    },
    identity
  );
}

function decodeV2(
  reader: BitReader,
  bits: boolean[],
  identity: VariantIdentityCatalog
): SharePayload | null {
  const header = readHeader(reader);
  if (!header) return null;
  const charEntries = readCharacterEntries(reader, header.charCount);
  if (!charEntries) return null;

  const skinEntries: Array<[number, string]> = [];
  if (header.hasSkins === 1) {
    const skinCount = reader.get(COUNT_BITS);
    if (skinCount === null) return null;
    for (let i = 0; i < skinCount; i++) {
      const baseId = reader.get(BASE_ID_BITS);
      const variantNumber = reader.get(VARIANT_ID_BITS);
      if (baseId === null || variantNumber === null) return null;
      skinEntries.push([baseId, String(variantNumber)]);
    }
  }

  if (!hasOnlyZeroPadding(reader, bits)) return null;
  return sanitizeSharePayload(
    {
      charEntries,
      skinEntries,
      defaultSkinMode: header.skinModeBit === 1 ? "insight" : "initial",
      showFutureSight: header.futureBit === 1,
    },
    identity
  );
}

/** Decode historical v1 or current v2; malformed tokens return null. */
export function decodeShareCode(
  token: string,
  identity: VariantIdentityCatalog = characterCatalog
): SharePayload | null {
  const raw = fromBase64Url(token);
  if (!raw || toBase64Url(raw) !== token) return null;

  const bits = bitsFromBytes(raw);
  const reader = new BitReader(bits);
  const version = reader.get(4);
  if (version === V1_VERSION) return decodeV1(reader, bits, identity);
  if (version === V2_VERSION) return decodeV2(reader, bits, identity);
  return null;
}
