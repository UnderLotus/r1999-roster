import assert from "node:assert/strict";

import { applyWikiMapping, type WikiCard } from "./sync-wiki-list";
import type { Character } from "./types";

function character(
  id: string,
  baseId: number,
  source?: { pageUrl?: string; imageUrl?: string }
): Character {
  return {
    id,
    name: `Character ${baseId}`,
    baseId,
    releaseOrder: baseId,
    enabled: true,
    stage: "pending-names",
    isReleased: false,
    skins: [],
    defaultVariant: `${baseId}01`,
    ...(source ? { source } : {}),
  };
}

const cards: WikiCard[] = [
  { id: 100101, name: "Alpha", href: "https://wiki.test/Alpha" },
  { id: 200201, name: "Beta", href: "https://wiki.test/Beta-new" },
];

// Bug regression：舊 pageUrl 不得蓋掉本次更新（spread 順序），
// 且既有 source 欄位（imageUrl）必須保留。
{
  const characters = [
    character("100101", 1001, {
      pageUrl: "https://wiki.test/Alpha-old",
      imageUrl: "https://img.test/alpha",
    }),
    character("200201", 2002, { pageUrl: "https://wiki.test/Beta-old" }),
    character("300301", 3003, { pageUrl: "https://wiki.test/Gamma" }),
  ];
  const result = applyWikiMapping(characters, cards);

  assert.equal(result.indexed, 2, "兩名在列表中的角色被索引");
  assert.equal(result.pageUrlUpdated, 2, "兩個 pageUrl 判定為需更新");
  assert.equal(result.pageUrlKept, 0, "無維持不變者");
  assert.deepEqual(result.notInWiki, ["300301"], "不在列表者回報");

  const alpha = characters[0]!;
  assert.equal(alpha.source?.pageUrl, "https://wiki.test/Alpha", "舊 pageUrl 被新 href 覆蓋");
  assert.equal(alpha.source?.imageUrl, "https://img.test/alpha", "imageUrl 保留");
  assert.equal(alpha._wikiIndex, 0, "_wikiIndex 依卡片順序標記");

  const beta = characters[1]!;
  assert.equal(beta.source?.pageUrl, "https://wiki.test/Beta-new", "Beta pageUrl 更新為新網址");
  assert.equal(beta._wikiIndex, 1, "Beta _wikiIndex 標記");

  const gamma = characters[2]!;
  assert.equal(gamma.source?.pageUrl, "https://wiki.test/Gamma", "不在列表者 source 不動");
  assert.equal(gamma._wikiIndex, undefined, "不在列表者不標記 _wikiIndex");
  console.log("ok: stale pageUrl is replaced and unrelated source fields survive");
}

// 冪等：href 與現值相同時維持不變，不重複計入 updated
{
  const characters = [
    character("100101", 1001, { pageUrl: "https://wiki.test/Alpha" }),
  ];
  const result = applyWikiMapping(characters, cards);
  assert.equal(result.pageUrlUpdated, 0, "相同 href 不計入 updated");
  assert.equal(result.pageUrlKept, 1, "相同 href 計入 kept");
  assert.equal(characters[0]!.source?.pageUrl, "https://wiki.test/Alpha", "值不變");
  console.log("ok: identical hrefs are idempotent");
}

// 無 source 的新角色取得 pageUrl
{
  const characters = [character("100101", 1001)];
  const result = applyWikiMapping(characters, cards);
  assert.equal(result.pageUrlUpdated, 1, "無 source 者計入 updated");
  assert.deepEqual(
    characters[0]!.source,
    { pageUrl: "https://wiki.test/Alpha" },
    "無 source 者建立僅含 pageUrl 的 source"
  );
  console.log("ok: characters without source gain pageUrl");
}

console.log("wiki mapping checks passed");
