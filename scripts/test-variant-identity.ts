import assert from "node:assert/strict";

import {
  createVariantIdentityCatalog,
  resolveCharacterVariant,
} from "../src/domain/variant-identity";
import type { Character } from "../src/types/character";

function character(overrides: Partial<Character> = {}): Character {
  return {
    id: "char-a",
    name: "A",
    baseId: 1001,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: true,
    defaultVariant: "700101",
    skins: [
      { variantId: "700101", type: "default", skinName: null, skinNameEng: null },
      { variantId: "700102", type: "insight", skinName: null, skinNameEng: null },
      { variantId: "700103", type: "skin", skinName: null, skinNameEng: null },
    ],
    ...overrides,
  };
}

const catalog = createVariantIdentityCatalog([character()]);
assert.equal(catalog.getCharacterByBaseId(1001)?.id, "char-a");
assert.equal(catalog.ownsVariant("char-a", "700103"), true);
assert.equal(catalog.ownsVariant("char-a", "100103"), false);
assert.equal(catalog.getDefaultVariant("char-a"), "700101");
assert.equal(catalog.getInsightVariant("char-a"), "700102");
assert.equal(catalog.resolveModeVariant("char-a", "initial"), "700101");
assert.equal(catalog.resolveModeVariant("char-a", "insight"), "700102");
assert.equal(resolveCharacterVariant(character(), "initial"), "700101");

assert.throws(() => createVariantIdentityCatalog([character(), character({ id: "char-b" })]));
assert.throws(() => createVariantIdentityCatalog([
  character(),
  character({ id: "char-b", baseId: 1002, defaultVariant: "700201", skins: [
    { variantId: "700201", type: "default", skinName: null, skinNameEng: null },
    { variantId: "700103", type: "skin", skinName: null, skinNameEng: null },
  ] }),
]));
assert.throws(() => createVariantIdentityCatalog([character({ defaultVariant: "not-owned" })]));
assert.throws(() => createVariantIdentityCatalog([character({ defaultVariant: "700103" })]));
assert.throws(() => createVariantIdentityCatalog([
  character({
    skins: [
      { variantId: "700101", type: "default", skinName: null, skinNameEng: null },
      { variantId: "700102", type: "default", skinName: null, skinNameEng: null },
      { variantId: "700103", type: "insight", skinName: null, skinNameEng: null },
    ],
  }),
]), /Multiple default variants/);

console.log("Variant identity regressions passed.");
