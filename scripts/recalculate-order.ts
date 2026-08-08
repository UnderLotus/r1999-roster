/**
 * Shared releaseOrder recalculation logic (v0.6).
 *
 * Three-tier priority:
 *   1. Huiji Wiki: characters with source.pageUrl — preserve existing order
 *   2. Kornblume: characters with rarity — sort by rarity desc, same-rarity by Kornblume Id
 *   3. CN Asset: remaining characters — place at front (newest first)
 *
 * Used by: build-characters.ts, build-names.ts, sync-assets.ts
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

  // Sort within each group
  fromWiki.sort((a, b) => a.releaseOrder - b.releaseOrder);
  fromAsset.sort((a, b) => a.baseId - b.baseId);

  fromKornblume.sort((a, b) => {
    const rA = a.rarity ?? 0;
    const rB = b.rarity ?? 0;
    if (rA !== rB) return rB - rA; // higher rarity first
    return (a._kbId ?? 0) - (b._kbId ?? 0);
  });

  // Stitch: CN Asset first (newest), then Kornblume (by rarity), then Wiki (preserved)
  const ordered = [...fromAsset, ...fromKornblume, ...fromWiki];

  // Assign sequential releaseOrder
  for (let i = 0; i < ordered.length; i++) {
    ordered[i].releaseOrder = i + 1;
  }

  return ordered;
}
