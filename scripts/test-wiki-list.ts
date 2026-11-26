import assert from "node:assert/strict";

import { applyWikiMapping, type WikiCard } from "./sync-wiki-list";
import type { Character } from "./types";

function character(
  id: string,
  baseId: number,
  source?: { pageUrl?: string; imageUrl?: string }
): Character {
  const defaultVariant = `${baseId}01`;
  return {
    id,
    name: `Character ${baseId}`,
    baseId,
    releaseOrder: baseId,
    enabled: true,
    stage: "pending-names",
    isReleased: false,
    skins: [
      { variantId: defaultVariant, type: "default", skinName: null, skinNameEng: null },
      ...(id === defaultVariant
        ? []
        : [{ variantId: id, type: "skin" as const, skinName: null, skinNameEng: null }]),
    ],
    defaultVariant,
    ...(source ? { source } : {}),
  };
}

const cards: WikiCard[] = [
  { id: 100101, name: "Alpha", href: "https://wiki.test/Alpha", rarity: 6 },
  // 8-digit owned variant: ownership must come from the Character catalog, not digits.
  { id: 10000201, name: "Beta", href: "https://wiki.test/Beta-new", rarity: 5 },
];

// Wiki rarity fills only missing character metadata; Kornblume rarity is never overwritten.
{
  const missing = character("100101", 1001);
  const existing = { ...character("10000201", 2002), rarity: 4 };
  const result = applyWikiMapping([missing, existing], cards);
  assert.equal(missing.rarity, 6);
  assert.equal(existing.rarity, 4);
  assert.equal(result.rarityUpdated, 1);
}

// Stale pageUrl is replaced while unrelated source fields survive; absent characters are reported.
{
  const characters = [
    character("100101", 1001, {
      pageUrl: "https://wiki.test/Alpha-old",
      imageUrl: "https://img.test/alpha",
    }),
    character("10000201", 2002, { pageUrl: "https://wiki.test/Beta-old" }),
    character("300301", 3003, { pageUrl: "https://wiki.test/Gamma" }),
  ];
  const result = applyWikiMapping(characters, cards);

  assert.equal(result.indexed, 2);
  assert.equal(result.pageUrlUpdated, 2);
  assert.equal(result.pageUrlKept, 0);
  assert.deepEqual(result.notInWiki, ["300301"]);

  assert.equal(characters[0].source?.pageUrl, "https://wiki.test/Alpha");
  assert.equal(characters[0].source?.imageUrl, "https://img.test/alpha");
  assert.equal(characters[0]._wikiIndex, 0);

  assert.equal(characters[1].source?.pageUrl, "https://wiki.test/Beta-new");
  assert.equal(characters[1]._wikiIndex, 1);

  assert.equal(characters[2].source?.pageUrl, "https://wiki.test/Gamma");
  assert.equal(characters[2]._wikiIndex, undefined);
}

// Identical hrefs are idempotent; characters without source gain pageUrl.
{
  const kept = character("100101", 1001, { pageUrl: "https://wiki.test/Alpha" });
  const fresh = character("10000201", 2002);
  const result = applyWikiMapping([kept, fresh], cards);
  assert.equal(result.pageUrlKept, 1);
  assert.equal(result.pageUrlUpdated, 1);
  assert.equal(kept.source?.pageUrl, "https://wiki.test/Alpha");
  assert.deepEqual(fresh.source, { pageUrl: "https://wiki.test/Beta-new" });
}

// Out-of-range Wiki rarity is rejected before mutating characters.
assert.throws(
  () =>
    applyWikiMapping(
      [character("100101", 1001)],
      [{ id: 100101, name: "Bad", href: "https://wiki.test/Bad", rarity: 7 }]
    ),
  /invalid Wiki rarity/
);

console.log("Wiki mapping checks passed.");
