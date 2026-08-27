// Pure Box-domain reconciliation tests. This entry point must not initialize Zustand.
import { reconcileBox } from "../src/domain/box";
import type { Character, PortrayLevel } from "../src/types/character";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

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
      {
        variantId: "100101",
        type: "default",
        skinName: null,
        skinNameEng: null,
      },
      {
        variantId: "100102",
        type: "insight",
        skinName: null,
        skinNameEng: null,
      },
      {
        variantId: "100103",
        type: "skin",
        skinName: null,
        skinNameEng: null,
        isReleased: false,
      },
      {
        variantId: "100104",
        type: "skin",
        skinName: null,
        skinNameEng: null,
      },
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
];

{
  const candidate = {
    characters: {
      "100101": { owned: true, portray: 9 as PortrayLevel },
      "100201": { owned: true, portray: 2 as PortrayLevel },
      "999901": { owned: true, portray: 3 as PortrayLevel },
    },
    activeVariant: {},
    customVariants: { "100101": true as const, "999901": true as const },
    defaultSkinMode: "insight" as const,
    showFutureSight: false,
  };
  const before = JSON.stringify(candidate);
  const result = reconcileBox(candidate, catalog);
  assert(
    Object.keys(result.characters).length === 1 &&
      result.characters["100101"]?.portray === 5,
    "Box model：未知／未實裝角色移除，塑造 clamp"
  );
  assert(
    result.activeVariant["100101"] === "100102" &&
      Object.keys(result.customVariants).length === 0,
    "Box model：缺少 variant 補 mode default，孤兒 custom 清除"
  );
  assert(JSON.stringify(candidate) === before, "Box model：不修改 candidate input");
}

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
  assert(
    result.activeVariant["100101"] === "100102" &&
      result.customVariants["100101"] === undefined,
    "Box model：FS off 未實裝 skin fallback 並清 custom"
  );
}

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
  assert(
    result.activeVariant["100101"] === "100101" &&
      result.customVariants["100101"] === undefined,
    "Box model：未知 variant 是非法值，fallback 並清 custom"
  );
}

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
  assert(
    result.characters["100201"]?.owned === true &&
      result.activeVariant["100101"] === "100103" &&
      result.customVariants["100101"] === true,
    "Box model：FS on 保留合法未實裝角色與 skin"
  );
}

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
  assert(
    result.activeVariant["100101"] === "100104" &&
      result.customVariants["100101"] === true,
    "Box model：FS off 保留已實裝 custom skin"
  );
}

console.log("done.");
