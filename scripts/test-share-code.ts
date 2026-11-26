// URL share token regressions: v1 compatibility, v2 exact identity, and sanitization.
import assert from "node:assert/strict";

import { characterCatalog } from "../src/data/characters";
import { createVariantIdentityCatalog } from "../src/domain/variant-identity";
import type { Character } from "../src/types/character";
import {
  decodeShareCode,
  encodeShareCode,
  sanitizeSharePayload,
} from "../src/utils/share-code";

function characterByBase(baseId: number): Character {
  const character = characterCatalog.getCharacterByBaseId(baseId);
  assert.ok(character, `catalog contains baseId ${baseId}`);
  return character;
}

function skinCharacter(variantId: string): Character {
  const character = characterCatalog.getCharacterByVariantId(variantId);
  assert.ok(character, `catalog owns ${variantId}`);
  return character;
}

const character3088 = characterByBase(3088);
const character3066 = characterByBase(3066);
const ordinarySkinCharacter = skinCharacter("314903");

// Fixed non-empty v2 golden token with synthetic non-prefix Character/Variant IDs:
// proves both wire format stability and catalog-backed identity resolution.
{
  const goldenCharacter: Character = {
    id: "character-alpha",
    name: "Synthetic",
    baseId: 1234,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: true,
    defaultVariant: "701001",
    skins: [
      { variantId: "701001", type: "default", skinName: null, skinNameEng: null },
      { variantId: "701002", type: "insight", skinName: null, skinNameEng: null },
      { variantId: "701777", type: "skin", skinName: null, skinNameEng: null },
    ],
  };
  const goldenIdentity = createVariantIdentityCatalog([goldenCharacter]);
  const goldenPayload = {
    characters: { [goldenCharacter.id]: { owned: true, portray: 1 as const } },
    activeVariant: { [goldenCharacter.id]: "701777" },
    customVariants: { [goldenCharacter.id]: true as const },
    defaultSkinMode: "initial" as const,
    showFutureSight: false,
  };
  const goldenToken = "IgImkQETSAVaqIA";
  assert.equal(encodeShareCode(goldenPayload, goldenIdentity), goldenToken);
  const goldenDecoded = decodeShareCode(goldenToken, goldenIdentity);
  assert.deepEqual(goldenDecoded, goldenPayload);
}

// Empty v2 token preserves header semantics.
{
  const token = encodeShareCode({
    characters: {},
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert.equal(token, "IAA");
  assert.deepEqual(decodeShareCode(token)?.characters, {});
}

// v2 round-trips 8-digit variants, ordinary skins, portray levels, and flags,
// while silently dropping unowned or wrong-owner customVariants on encode.
{
  const payload = {
    characters: {
      [character3088.id]: { owned: true, portray: 0 as const },
      [character3066.id]: { owned: true, portray: 5 as const },
      [ordinarySkinCharacter.id]: { owned: true, portray: 2 as const },
    },
    activeVariant: {
      [character3088.id]: "30880001",
      [character3066.id]: "30660001",
      [ordinarySkinCharacter.id]: "314903",
      "unowned-id": "30880001",
    },
    customVariants: {
      [character3088.id]: true,
      [character3066.id]: true,
      [ordinarySkinCharacter.id]: true,
      "unowned-id": true,
    } as Record<string, true>,
    defaultSkinMode: "insight" as const,
    showFutureSight: true,
  };
  const token = encodeShareCode(payload);
  const decoded = decodeShareCode(token);
  assert.deepEqual(decoded, {
    characters: payload.characters,
    activeVariant: {
      [character3088.id]: "30880001",
      [character3066.id]: "30660001",
      [ordinarySkinCharacter.id]: "314903",
    },
    customVariants: {
      [character3088.id]: true,
      [character3066.id]: true,
      [ordinarySkinCharacter.id]: true,
    },
    defaultSkinMode: "insight",
    showFutureSight: true,
  });
}

// Fixed historical v1 fixtures must remain permanently decodable.
{
  // v1 [baseId=3088, portray=3, suffix=03, insight, futureSight=true]
  const decoded = decodeShareCode("HgJggwEwQBg");
  assert.equal(decoded?.characters[character3088.id]?.portray, 3);
  assert.equal(decoded?.activeVariant[character3088.id], "308803");
  assert.equal(decoded?.customVariants[character3088.id], true);
  assert.equal(decoded?.defaultSkinMode, "insight");
  assert.equal(decoded?.showFutureSight, true);
  assert.deepEqual(decodeShareCode("EAA")?.characters, {});

  // v1 suffix 01 maps only to historical 6-digit default, never an 8-digit skin ending in 01.
  assert.equal(decodeShareCode("HgJggwEwQAg")?.activeVariant[character3088.id], "308801");
  const v2 = encodeShareCode({
    characters: { [character3088.id]: { owned: true, portray: 0 } },
    activeVariant: { [character3088.id]: "30880001" },
    customVariants: { [character3088.id]: true },
    defaultSkinMode: "initial",
    showFutureSight: true,
  });
  assert.equal(decodeShareCode(v2)?.activeVariant[character3088.id], "30880001");
}

// Sanitization: unknown baseIds, duplicate entries, out-of-range portray, unowned skins,
// wrong-owner variants, and duplicate skin entries.
{
  const result = sanitizeSharePayload({
    charEntries: [
      [character3088.baseId, -1],
      [character3066.baseId, 7],
      [9999, 4],
      [character3088.baseId, 3],
    ],
    skinEntries: [
      [character3088.baseId, "30660001"], // wrong owner
      [character3088.baseId, "30880001"],
      [character3088.baseId, "308803"], // duplicate skin for same character
      [character3066.baseId, "30660001"],
      [ordinarySkinCharacter.baseId, "314903"], // character not owned
    ],
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert.deepEqual(result.characters, {
    [character3088.id]: { owned: true, portray: 0 },
    [character3066.id]: { owned: true, portray: 5 },
  });
  assert.deepEqual(result.activeVariant, {
    [character3088.id]: "30880001",
    [character3066.id]: "30660001",
  });
  assert.deepEqual(result.customVariants, {
    [character3088.id]: true,
    [character3066.id]: true,
  });
}

// Variant IDs outside the 27-bit unsigned integer range fail explicitly rather than truncating.
{
  const unsupported: Character = {
    id: "character-large-variant",
    name: "Unsupported",
    baseId: 1235,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: true,
    defaultVariant: "702001",
    skins: [
      { variantId: "702001", type: "default", skinName: null, skinNameEng: null },
      { variantId: "134217728", type: "skin", skinName: null, skinNameEng: null },
    ],
  };
  const identity = createVariantIdentityCatalog([unsupported]);
  assert.throws(
    () =>
      encodeShareCode(
        {
          characters: { [unsupported.id]: { owned: true, portray: 0 } },
          activeVariant: { [unsupported.id]: "134217728" },
          customVariants: { [unsupported.id]: true },
          defaultSkinMode: "initial",
          showFutureSight: false,
        },
        identity
      ),
    RangeError
  );
}

// Malformed, non-base64url, truncated, trailing-data, non-zero-padding, and unknown-version tokens reject.
assert.equal(decodeShareCode(""), null);
assert.equal(decodeShareCode("!!!not-base64url!!!"), null);
assert.equal(decodeShareCode("AAA"), null, "version 0 is rejected");
assert.equal(decodeShareCode("IAB"), null, "non-zero trailing padding bits are rejected");
{
  const token = encodeShareCode({
    characters: { [character3088.id]: { owned: true, portray: 0 } },
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "initial",
    showFutureSight: false,
  });
  assert.equal(decodeShareCode(token.slice(0, -1)), null, "truncated token rejects");
  assert.equal(decodeShareCode(`${token}A`), null, "trailing data rejects");
}

console.log("Share-code checks passed.");
