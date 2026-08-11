// URL 分享 token（spec §25）單元測試：round-trip、消毒、長度
import {
  decodeShareCode,
  encodeShareCode,
  sanitizeSharePayload,
} from "../src/utils/share-code";
import { characters } from "../src/data/characters";
import type { CharacterState, PortrayLevel } from "../src/types/character";

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

const A = characters[0]; // 任一已知角色
const B = characters[1];
const C = characters[2];

// 測試用 skin：優先取非初始 variant（若角色只有一張則退回初始）
const skinVariant =
  A.skins.length > 1 ? A.skins[1].variantId : A.skins[0].variantId;

const baseId = (id: string) => parseInt(id.slice(0, 4), 10);

const highSuffixCharacter = characters.find((character) =>
  character.skins.some((skin) => parseInt(skin.variantId.slice(-2), 10) > 7)
);
if (!highSuffixCharacter) throw new Error("測試資料缺少 suffix > 7 的 skin");
const highSuffixVariant = highSuffixCharacter.skins.find(
  (skin) => parseInt(skin.variantId.slice(-2), 10) > 7
)!.variantId;

// ---------- round-trip ----------

// 空 box：encode 後仍是合法 token，decode 回空
{
  const token = encodeShareCode({
    characters: {},
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  const decoded = decodeShareCode(token);
  assert(decoded !== null, "空 box round-trip：可解碼");
  assert(
    decoded !== null && Object.keys(decoded.characters).length === 0,
    "空 box round-trip：角色為空"
  );
  assert(
    decoded !== null &&
      decoded.showFutureSight === false &&
      decoded.defaultSkinMode === "initial",
    "空 box round-trip：旗標正確"
  );
}

// 三角色（含 0 塑）+ skin + 洞悉 + 未來視
{
  const payload = {
    characters: {
      [A.id]: { owned: true, portray: 0 as const },
      [B.id]: { owned: true, portray: 1 as const },
      [C.id]: { owned: true, portray: 5 as const },
    },
    activeVariant: { [A.id]: skinVariant },
    customVariants: { [A.id]: true } as const,
    defaultSkinMode: "insight" as const,
    showFutureSight: true,
  };
  const token = encodeShareCode(payload);
  const decoded = decodeShareCode(token);
  assert(decoded !== null, "三角色 round-trip：可解碼");
  assert(
    decoded !== null &&
      decoded.characters[A.id]?.portray === 0 &&
      decoded.characters[B.id]?.portray === 1 &&
      decoded.characters[C.id]?.portray === 5,
    "三角色 round-trip：0–5 塑造正確"
  );
  assert(
    decoded !== null &&
      decoded.activeVariant[A.id] === skinVariant &&
      decoded.customVariants[A.id] === true,
    "三角色 round-trip：skin 正確"
  );
  assert(
    decoded !== null &&
      decoded.defaultSkinMode === "insight" &&
      decoded.showFutureSight === true,
    "三角色 round-trip：mode/future 正確"
  );
}

// 兩位數 skin suffix（目前資料含 31）必須保留
{
  const token = encodeShareCode({
    characters: {
      [highSuffixCharacter.id]: { owned: true, portray: 0 },
    },
    activeVariant: { [highSuffixCharacter.id]: highSuffixVariant },
    customVariants: { [highSuffixCharacter.id]: true },
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  const decoded = decodeShareCode(token);
  assert(
    decoded?.activeVariant[highSuffixCharacter.id] === highSuffixVariant,
    "skin suffix 31 round-trip 正確"
  );
}

// ---------- sanitize：直接餵髒輸入 ----------

// 未知角色跳過、重複去重、塑造 clamp
{
  const result = sanitizeSharePayload({
    charEntries: [
      [9999, 3], // 未知 baseId
      [baseId(A.id), 3],
      [baseId(A.id), 5], // 重複
      [baseId(B.id), 7], // 塑造超界
      [baseId(C.id), -3], // 塑造過低
    ],
    skinEntries: [],
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert(result.characters[A.id]?.portray === 3, "消毒：重複保留第一個");
  assert(result.characters[B.id]?.portray === 5, "消毒：塑造 clamp 到 5");
  assert(result.characters[C.id]?.portray === 0, "消毒：塑造 clamp 到 0");
  assert(
    result.characters["999901"] === undefined,
    "消毒：未知角色被跳過"
  );
  assert(Object.keys(result.characters).length === 3, "消毒：三個已知角色保留");
}

// 非法 variant 跳過
{
  const result = sanitizeSharePayload({
    charEntries: [[baseId(A.id), 2]],
    skinEntries: [
      [baseId(A.id), 99], // 非法 variant（只有 1-6）
      [baseId(A.id), 1], // 合法（01）
    ],
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert(
    result.activeVariant[A.id] === A.id && Object.keys(result.customVariants).length === 1,
    "消毒：非法 variant 跳過、合法保留"
  );
}

// ---------- decode 拒絕壞 token ----------

assert(decodeShareCode("") === null, "壞 token：空字串拒絕");
assert(decodeShareCode("!!!not-base64url!!!") === null, "壞 token：非法字元拒絕");

{
  const token = encodeShareCode({
    characters: { [A.id]: { owned: true, portray: 0 } },
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert(decodeShareCode(token.slice(0, -1)) === null, "壞 token：截斷資料拒絕");
  assert(decodeShareCode(`${token}A`) === null, "壞 token：附加資料拒絕");
}

// 明確檢查版本不符：AAA= (0x00 0x00 0x00) → version bits 0000 ≠ 1
{
  // 手動拼一個 version=0 的 token：4 bits 0000 + 後面任意
  const bits: boolean[] = [false, false, false, false, false, false, false, false];
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  const b64 = Buffer.from(bytes).toString("base64").replace(/=+$/, "");
  assert(decodeShareCode(b64) === null, "壞 token：version 0 拒絕");
}

// ---------- 長度 sanity：60 隻 < 250 碼 ----------

{
  const many: Record<string, CharacterState> = {};
  for (let i = 0; i < Math.min(60, characters.length); i++) {
    many[characters[i].id] = {
      owned: true,
      portray: ((i % 5) + 1) as PortrayLevel,
    };
  }
  const token = encodeShareCode({
    characters: many,
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  const decoded = decodeShareCode(token);
  assert(token.length < 250, `60 隻長度合理（${token.length} < 250）`);
  assert(
    decoded !== null &&
      Object.keys(decoded.characters).length === Object.keys(many).length,
    "60 隻 round-trip：數量一致"
  );
}

console.log("done.");
