import { characters } from "../data/characters";
import type { BoxState, SkinMode } from "../domain/box";
import type { CharacterState, PortrayLevel } from "../types/character";

/**
 * URL 分享 token v1（spec §25）
 *
 * 概念：把 Box 狀態壓縮成一段可逆編碼，放進網址 fragment（#b=<token>）。
 * 對方開啟網址時前端自動解碼還原，純靜態站即可運作，不需要後端。
 *
 * 格式（位元打包 → base64url，零轉義）：
 *
 *   [4]  version = 1
 *   [1]  skinMode    0=初始, 1=洞悉
 *   [1]  futureSight 0=off, 1=on
 *   [1]  hasSkins
 *   [8]  charCount N
 *   N × [14 baseId][3 portray 0-5]           只列持有的角色（稀疏）
 *   [8]  skinCount M（hasSkins=1 時）
 *   M × [14 baseId][7 variantSuffix 1-99]     手動切換過的 skin
 *
 * 錨點規則（ID 錨點）：
 * - 只使用官方 base ID（6 位 variant ID 的前 4 位，如 314901 → 3149）。
 *   角色列表增減／排序重算都不影響舊 token；解碼時未知角色直接跳過。
 * - 解碼全程消毒：版本檢查、未知 baseId 跳過、塑造 clamp 0-5、
 *   variant 對照 VALID_VARIANTS、位元不足即拒絕。
 */

export type SharePayload = BoxState;

const VERSION = 1;

/** 已知角色 id（{baseId}01）集合（解碼消毒用） */
const KNOWN_CHAR_IDS = new Set(characters.map((c) => c.id));

/** 每角色的合法 variantId 集合（解碼消毒用） */
const VALID_VARIANTS = new Map(
  characters.map((c) => [c.id, new Set(c.skins.map((s) => s.variantId))])
);

/* ---------- base64url（RFC 4648 §5，無 padding） ---------- */

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

/* ---------- 位元讀取 ---------- */

class BitReader {
  private pos = 0;
  constructor(private readonly bits: boolean[]) {}

  get position(): number {
    return this.pos;
  }

  /** 讀取 n bits；不足回傳 null（結構錯誤 → 整個拒絕） */
  get(n: number): number | null {
    if (this.pos + n > this.bits.length) return null;
    let value = 0;
    for (let i = 0; i < n; i++) {
      value = (value << 1) | (this.bits[this.pos++] ? 1 : 0);
    }
    return value;
  }
}

/* ---------- ID 輔助 ---------- */

function parseBaseId(id: string): number | null {
  if (!/^\d{6}$/.test(id)) return null;
  return parseInt(id.slice(0, 4), 10);
}

const pad4 = (n: number): string => String(n).padStart(4, "0");
const pad2 = (n: number): string => String(n).padStart(2, "0");

/* ---------- 編碼 ---------- */

export function encodeShareCode(input: {
  characters: Record<string, CharacterState>;
  activeVariant: Record<string, string>;
  customVariants: Record<string, true>;
  defaultSkinMode: SkinMode;
  showFutureSight: boolean;
}): string {
  // 持有角色：稀疏列出，0 塑仍是持有狀態，必須保留。
  const owned: Array<[number, number]> = [];
  const ownedIds = new Set<string>();
  for (const [id, state] of Object.entries(input.characters)) {
    if (!state?.owned) continue;
    const baseId = parseBaseId(id);
    if (baseId === null || !KNOWN_CHAR_IDS.has(id)) continue;
    owned.push([baseId, state.portray]);
    ownedIds.add(id);
  }
  owned.sort((a, b) => a[0] - b[0]);

  // 手動切換過的 skin（僅限已持有角色，且 variant 必須合法）
  const skins: Array<[number, number]> = [];
  for (const id of Object.keys(input.customVariants)) {
    const variantId = input.activeVariant[id];
    const baseId = parseBaseId(id);
    if (!ownedIds.has(id) || !variantId || baseId === null) continue;
    if (!VALID_VARIANTS.get(id)?.has(variantId)) continue;
    const suffix = parseInt(variantId.slice(-2), 10);
    if (!Number.isInteger(suffix) || suffix < 1 || suffix > 99) continue;
    skins.push([baseId, suffix]);
  }
  skins.sort((a, b) => a[0] - b[0]);

  const bits: boolean[] = [];
  const put = (value: number, n: number): void => {
    for (let i = n - 1; i >= 0; i--) {
      bits.push(((value >> i) & 1) === 1);
    }
  };

  put(VERSION, 4);
  put(input.defaultSkinMode === "insight" ? 1 : 0, 1);
  put(input.showFutureSight ? 1 : 0, 1);
  put(skins.length > 0 ? 1 : 0, 1);
  put(owned.length, 8);
  for (const [baseId, portray] of owned) {
    put(baseId, 14);
    put(portray, 3);
  }
  if (skins.length > 0) {
    put(skins.length, 8);
    for (const [baseId, variantSuffix] of skins) {
      put(baseId, 14);
      put(variantSuffix, 7);
    }
  }

  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return toBase64Url(bytes);
}

/* ---------- 解碼與消毒 ---------- */

interface RawSharePayload {
  charEntries: Array<[number, number]>;
  skinEntries: Array<[number, number]>;
  defaultSkinMode: SkinMode;
  showFutureSight: boolean;
}

/**
 * 消毒：URL 是不可信輸入。未知角色/非法 variant 跳過、塑造 clamp。
 * 分離出來是為了讓測試可以直接覆蓋各種骯髒輸入。
 */
export function sanitizeSharePayload(raw: RawSharePayload): SharePayload {
  const characters: Record<string, CharacterState> = {};
  const seen = new Set<string>();
  for (const [baseId, portray] of raw.charEntries) {
    const id = `${pad4(baseId)}01`;
    if (!KNOWN_CHAR_IDS.has(id)) continue; // 未知角色：跳過（ID 錨點）
    if (seen.has(id)) continue; // 重複：跳過
    seen.add(id);
    characters[id] = {
      owned: true,
      portray: Math.min(5, Math.max(0, portray)) as PortrayLevel,
    };
  }

  const activeVariant: Record<string, string> = {};
  const customVariants: Record<string, true> = {};
  for (const [baseId, variantNum] of raw.skinEntries) {
    const id = `${pad4(baseId)}01`;
    const variantId = `${pad4(baseId)}${pad2(variantNum)}`;
    if (!characters[id]) continue; // 非持有角色的 skin：跳過
    if (!VALID_VARIANTS.get(id)?.has(variantId)) continue; // 非法 variant：跳過
    activeVariant[id] = variantId;
    customVariants[id] = true;
  }

  return {
    characters,
    activeVariant,
    customVariants,
    defaultSkinMode: raw.defaultSkinMode,
    showFutureSight: raw.showFutureSight,
  };
}

export function decodeShareCode(token: string): SharePayload | null {
  const raw = fromBase64Url(token);
  if (!raw || toBase64Url(raw) !== token) return null;

  const bits: boolean[] = [];
  for (const byte of raw) {
    for (let i = 7; i >= 0; i--) bits.push(((byte >> i) & 1) === 1);
  }

  const reader = new BitReader(bits);
  if (reader.get(4) !== VERSION) return null;

  const skinModeBit = reader.get(1);
  const futureBit = reader.get(1);
  const hasSkins = reader.get(1);
  if (skinModeBit === null || futureBit === null || hasSkins === null) {
    return null;
  }

  const charCount = reader.get(8);
  if (charCount === null) return null;

  const charEntries: Array<[number, number]> = [];
  for (let i = 0; i < charCount; i++) {
    const baseId = reader.get(14);
    const portray = reader.get(3);
    if (baseId === null || portray === null) return null;
    charEntries.push([baseId, portray]);
  }

  const skinEntries: Array<[number, number]> = [];
  if (hasSkins === 1) {
    const skinCount = reader.get(8);
    if (skinCount === null) return null;
    for (let i = 0; i < skinCount; i++) {
      const baseId = reader.get(14);
      const variantSuffix = reader.get(7);
      if (baseId === null || variantSuffix === null) return null;
      skinEntries.push([baseId, variantSuffix]);
    }
  }

  // 只允許最後一個 byte 的補零；拒絕附加資料與非零 padding。
  if (raw.length !== Math.ceil(reader.position / 8)) return null;
  for (let i = reader.position; i < bits.length; i++) {
    if (bits[i]) return null;
  }

  return sanitizeSharePayload({
    charEntries,
    skinEntries,
    defaultSkinMode: skinModeBit === 1 ? "insight" : "initial",
    showFutureSight: futureBit === 1,
  });
}
