// Pure runtime domain tests (variant-identity, box reconciliation, i18n display).
// This entry point must not initialize Zustand or touch localStorage.
import assert from "node:assert/strict";

import { reconcileBox } from "../src/domain/box";
import {
  createVariantIdentityCatalog,
  resolveCharacterVariant,
} from "../src/domain/variant-identity";
import type { Character, PortrayLevel } from "../src/types/character";
import { getAllNames, getDisplayName } from "../src/utils/i18n";

function makeCharacter(overrides: Partial<Character> = {}): Character {
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

function testVariantIdentity(): void {
  const withInsight = makeCharacter();
  const withoutInsight = makeCharacter({
    id: "char-no-insight",
    baseId: 1002,
    defaultVariant: "700201",
    skins: [
      { variantId: "700201", type: "default", skinName: null, skinNameEng: null },
      { variantId: "700203", type: "skin", skinName: null, skinNameEng: null },
    ],
  });
  const catalog = createVariantIdentityCatalog([withInsight, withoutInsight]);

  assert.equal(catalog.getCharacterByBaseId(1001)?.id, "char-a");
  assert.equal(catalog.ownsVariant("char-a", "700103"), true);
  assert.equal(catalog.ownsVariant("char-a", "100103"), false, "ownership never infers from baseId prefix");
  assert.equal(catalog.getDefaultVariant("char-a"), "700101");
  assert.equal(catalog.getInsightVariant("char-a"), "700102");
  assert.equal(catalog.resolveModeVariant("char-a", "initial"), "700101");
  assert.equal(catalog.resolveModeVariant("char-a", "insight"), "700102");
  assert.equal(resolveCharacterVariant(withInsight, "initial"), "700101");
  assert.equal(
    catalog.resolveModeVariant("char-no-insight", "insight"),
    "700201",
    "insight mode falls back to defaultVariant when no insight variant exists"
  );
  assert.equal(resolveCharacterVariant(withoutInsight, "insight"), "700201");

  // Catalog integrity rejections
  assert.throws(
    () => createVariantIdentityCatalog([makeCharacter(), makeCharacter({ id: "char-b" })]),
    /Duplicate Character baseId/
  );
  assert.throws(
    () =>
      createVariantIdentityCatalog([
        makeCharacter(),
        makeCharacter({
          id: "char-b",
          baseId: 1002,
          defaultVariant: "700201",
          skins: [
            { variantId: "700201", type: "default", skinName: null, skinNameEng: null },
            { variantId: "700103", type: "skin", skinName: null, skinNameEng: null },
          ],
        }),
      ]),
    /belongs to both/
  );
  assert.throws(
    () => createVariantIdentityCatalog([makeCharacter({ defaultVariant: "not-owned" })]),
    /is not owned by the Character/
  );
  assert.throws(
    () => createVariantIdentityCatalog([makeCharacter({ defaultVariant: "700103" })]),
    /is not typed as default/
  );
  assert.throws(
    () =>
      createVariantIdentityCatalog([
        makeCharacter({
          skins: [
            { variantId: "700101", type: "default", skinName: null, skinNameEng: null },
            { variantId: "700102", type: "default", skinName: null, skinNameEng: null },
            { variantId: "700103", type: "insight", skinName: null, skinNameEng: null },
          ],
        }),
      ]),
    /Multiple default variants/
  );
  assert.throws(
    () =>
      createVariantIdentityCatalog([
        makeCharacter({
          skins: [
            { variantId: "700101", type: "default", skinName: null, skinNameEng: null },
            { variantId: "700102", type: "insight", skinName: null, skinNameEng: null },
            { variantId: "700104", type: "insight", skinName: null, skinNameEng: null },
          ],
        }),
      ]),
    /Multiple insight variants/
  );
}

function testBoxReconciliation(): void {
  const catalog: Character[] = [
    {
      id: "100101",
      baseId: 1001,
      name: "Released",
      releaseOrder: 1,
      enabled: true,
      stage: "live",
      isReleased: true,
      defaultVariant: "100101",
      skins: [
        { variantId: "100101", type: "default", skinName: null, skinNameEng: null },
        { variantId: "100102", type: "insight", skinName: null, skinNameEng: null },
        {
          variantId: "100103",
          type: "skin",
          skinName: null,
          skinNameEng: null,
          isReleased: false,
        },
        { variantId: "100104", type: "skin", skinName: null, skinNameEng: null },
      ],
    },
    {
      id: "100201",
      baseId: 1002,
      name: "Unreleased",
      releaseOrder: 2,
      enabled: true,
      stage: "live",
      isReleased: false,
      defaultVariant: "100201",
      skins: [
        {
          variantId: "100201",
          type: "default",
          skinName: null,
          skinNameEng: null,
          isReleased: false,
        },
      ],
    },
    {
      id: "100301",
      baseId: 1003,
      name: "NoInsight",
      releaseOrder: 3,
      enabled: true,
      stage: "live",
      isReleased: true,
      defaultVariant: "100301",
      skins: [
        { variantId: "100301", type: "default", skinName: null, skinNameEng: null },
      ],
    },
  ];

  // Unknown, unowned, and unreleased (when FS off) characters are pruned; portray is normalized;
  // missing variants fall back to mode default (or defaultVariant without insight); input stays immutable.
  {
    const candidate = {
      characters: {
        "100101": { owned: true, portray: 9 as PortrayLevel },
        "100201": { owned: true, portray: 2 as PortrayLevel },
        "100301": { owned: true, portray: 1.5 as PortrayLevel },
        "999901": { owned: true, portray: 3 as PortrayLevel },
      },
      activeVariant: {},
      customVariants: { "100101": true as const, "999901": true as const },
      defaultSkinMode: "insight" as const,
      showFutureSight: false,
    };
    const before = structuredClone(candidate);
    const result = reconcileBox(candidate, catalog);

    assert.deepEqual(result.characters, {
      "100101": { owned: true, portray: 5 },
      "100301": { owned: true, portray: 0 },
    });
    assert.deepEqual(result.activeVariant, {
      "100101": "100102",
      "100301": "100301",
    });
    assert.deepEqual(result.customVariants, {});
    assert.deepEqual(candidate, before, "reconcileBox never mutates candidate input");
  }

  // owned: false entries and negative/NaN portray are handled safely.
  {
    const result = reconcileBox(
      {
        characters: {
          "100101": { owned: false, portray: 3 },
          "100301": { owned: true, portray: -2 as PortrayLevel },
        },
        activeVariant: { "100101": "100104" },
        customVariants: { "100101": true },
        defaultSkinMode: "initial",
        showFutureSight: false,
      },
      catalog
    );
    assert.deepEqual(result.characters, { "100301": { owned: true, portray: 0 } });
    assert.equal(result.activeVariant["100101"], undefined);
    assert.equal(result.customVariants["100101"], undefined);
  }

  // FS off: unreleased skin falls back to mode default and clears custom.
  {
    const result = reconcileBox(
      {
        characters: { "100101": { owned: true, portray: 0 } },
        activeVariant: { "100101": "100103" },
        customVariants: { "100101": true },
        defaultSkinMode: "insight",
        showFutureSight: false,
      },
      catalog
    );
    assert.equal(result.activeVariant["100101"], "100102");
    assert.equal(result.customVariants["100101"], undefined);
  }

  // Unknown variant is repaired and clears custom.
  {
    const result = reconcileBox(
      {
        characters: { "100101": { owned: true, portray: 0 } },
        activeVariant: { "100101": "100199" },
        customVariants: { "100101": true },
        defaultSkinMode: "initial",
        showFutureSight: false,
      },
      catalog
    );
    assert.equal(result.activeVariant["100101"], "100101");
    assert.equal(result.customVariants["100101"], undefined);
  }

  // FS on: retains valid unreleased character and unreleased skin.
  {
    const result = reconcileBox(
      {
        characters: {
          "100101": { owned: true, portray: 0 },
          "100201": { owned: true, portray: 1 },
        },
        activeVariant: { "100101": "100103", "100201": "100201" },
        customVariants: { "100101": true, "100201": true },
        defaultSkinMode: "initial",
        showFutureSight: true,
      },
      catalog
    );
    assert.equal(result.characters["100201"]?.owned, true);
    assert.equal(result.activeVariant["100101"], "100103");
    assert.equal(result.customVariants["100101"], true);
  }

  // FS off: retains released custom skin.
  {
    const result = reconcileBox(
      {
        characters: { "100101": { owned: true, portray: 0 } },
        activeVariant: { "100101": "100104" },
        customVariants: { "100101": true },
        defaultSkinMode: "initial",
        showFutureSight: false,
      },
      catalog
    );
    assert.equal(result.activeVariant["100101"], "100104");
    assert.equal(result.customVariants["100101"], true);
  }
}

function testDisplayNameAndSearch(): void {
  // Display fallback order: requested lang -> en-US -> zh-CN -> character.name,
  // without ever mutating sparse names (CMP-09).
  const sparse = makeCharacter({
    name: "佩施塔",
    names: Object.freeze({ "zh-CN": "佩施塔", "en-US": "Perchta" }),
  });
  assert.equal(getDisplayName(sparse, "zh-CN"), "佩施塔");
  assert.equal(getDisplayName(sparse, "en-US"), "Perchta");
  assert.equal(getDisplayName(sparse, "ja-JP"), "Perchta", "missing ja-JP falls back to en-US");
  assert.equal(
    Object.prototype.hasOwnProperty.call(sparse.names, "ja-JP"),
    false,
    "display fallback never writes back into names"
  );

  const zhOnly = makeCharacter({
    name: "原始名",
    names: { "zh-CN": "简中名" },
  });
  assert.equal(getDisplayName(zhOnly, "ko-KR"), "简中名", "falls back to zh-CN when en-US is absent");

  const unnamed = makeCharacter({ name: "FallbackName", names: undefined });
  assert.equal(getDisplayName(unnamed, "en-US"), "FallbackName");

  // Cross-language search collects character.name + all distinct localized values.
  const multilingual = makeCharacter({
    name: "APPLe",
    names: {
      "zh-CN": "APPLe",
      "en-US": "APPLe",
      "ja-JP": "APPLe",
      "ko-KR": "애플",
    },
  });
  assert.deepEqual(getAllNames(multilingual), ["APPLe", "애플"]);
}

testVariantIdentity();
testBoxReconciliation();
testDisplayNameAndSearch();

console.log("Box domain, variant identity, and i18n checks passed.");
