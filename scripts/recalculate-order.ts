/**
 * Shared releaseOrder recalculation logic (v0.6).
 *
 * 注意：此函數會 **mutate** 輸入陣列（排序子陣列並直接寫入各物件的
 * `releaseOrder`），不保證純粹。呼叫端應以「load → mutate → write back」
 * 方式使用。
 *
 * Three-tier priority:
 *   1. Huiji Wiki: characters with source.pageUrl — sorted by _wikiIndex
 *      (live 灰機 列表序，由 sync:wiki 寫入)；無 _wikiIndex 時回退既有
 *      releaseOrder（手動編輯／未跑 sync:wiki 的情形）。
 *   2. Kornblume: characters with rarity — sort by rarity desc, same-rarity by Kornblume Id
 *   3. CN Asset: remaining characters — place at front (newest first)
 *
 * Used by: build-characters.ts, build-names.ts, sync-assets.ts, sync-wiki-list.ts
 */

import type { Character } from "./types";

export function recalculateReleaseOrder(characters: Character[]): Character[] {
  // Group by priority source
  const fromWiki: Character[] = [];
  const fromKornblume: Character[] = [];
  const fromAsset: Character[] = [];

  for (const c of characters) {
    if (c.source?.pageUrl) {
      fromWiki.push(c);
    } else if (c.rarity !== undefined) {
      fromKornblume.push(c);
    } else {
      fromAsset.push(c);
    }
  }

  // Sort within each group.
  // Wiki tier: live list order (_wikiIndex, 0-based) wins. Characters that
  // keep pageUrl but are missing from the fetched list (legacy / manual
  // entries) are sorted in a separate disjoint domain by existing
  // releaseOrder — mixing both domains in one comparator would let numeric
  // collisions drift positions on every rerun (non-idempotent).
  const fromWikiIndexed = fromWiki.filter((c) => c._wikiIndex !== undefined);
  const fromWikiLegacy = fromWiki.filter((c) => c._wikiIndex === undefined);
  fromWikiIndexed.sort((a, b) => (a._wikiIndex ?? 0) - (b._wikiIndex ?? 0));
  fromWikiLegacy.sort((a, b) => a.releaseOrder - b.releaseOrder);
  fromAsset.sort((a, b) => a.baseId - b.baseId);

  fromKornblume.sort((a, b) => {
    const rA = a.rarity ?? 0;
    const rB = b.rarity ?? 0;
    if (rA !== rB) return rB - rA; // higher rarity first
    return (a._kbId ?? 0) - (b._kbId ?? 0);
  });

  // Stitch: CN Asset first (newest), then Kornblume (by rarity), then Wiki
  // (indexed by live list order, legacy preserved-order chars appended)
  const ordered = [
    ...fromAsset,
    ...fromKornblume,
    ...fromWikiIndexed,
    ...fromWikiLegacy,
  ];

  // Assign sequential releaseOrder
  for (let i = 0; i < ordered.length; i++) {
    ordered[i].releaseOrder = i + 1;
  }

  return ordered;
}
