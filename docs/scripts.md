# Scripts

Maintenance scripts for data sync, character building, and testing.

---

## Script Overview

| Script | Command | Purpose |
|---|---|---|
| `sync-assets.ts` | `npm run sync` | Wipe old images + download official headicons from CN asset repo |
| `build-characters.ts` | `npm run build:characters` | Incremental maintenance: update skins, detect new chars, recalculate ordering |
| `build-names.ts` | `npm run build:names` | Fetch multilingual names + rarity from Kornblume, upgrade stage |
| `build-id-map.ts` | `npm run build:id-map` | Generate wiki→variant ID mapping (one-shot, already done) |
| `test-store.ts` | `npm run test:store` | Unit tests for Zustand store logic and persistence migration |

Archived (v0.4): `scripts/archive/sync-characters-v0.4.ts`, `scripts/archive/download-images-v0.4.py`.

---

## Recommended Update Pipeline

```bash
# 1. Update ArcanistMap.json from CN asset repo (manual step)
cp /tmp/r1999-asset-sync/mappings/ArcanistMap.json scripts/data/

# 2. Download latest images + detect new characters
npm run sync

# 3. Incremental maintenance: skins + ordering
npm run build:characters

# 4. Names + rarity + ordering
npm run build:names
```

Or combined: `npm run sync && npm run build:characters && npm run build:names`.

---

## `npm run sync` — Asset Sync

1. Wipes all old wiki-based image subdirectories under `public/assets/characters/`
2. Shallow-clones the CN asset repo with sparse checkout of `singlebg/headicon_middle/`
3. Copies matching variant PNGs to `public/assets/characters/avatars/`
4. Detects characters in `ArcanistMap.json` that are not yet in `characters.json`:
   - Image exists → auto-adds to `characters.json` with `stage: "pending-names"`
   - Image missing → writes to `scripts/data/pending-characters.json`
5. Recalculates `releaseOrder` for all characters (3-tier priority: Wiki > Kornblume rarity > CN Asset)

---

## `npm run build:characters` — Incremental Character Maintenance

1. Loads `ArcanistMap.json` and existing `characters.json`
2. Updates `skins[]` for existing characters (new variants from ArcanistMap)
3. Detects new characters in ArcanistMap not yet in `characters.json`:
   - Checks `public/assets/characters/avatars/{baseId}01.png` existence
   - Image exists → adds with `stage: "pending-names"`, `enabled: true`
   - Image missing → writes to `pending-characters.json`
4. Runs `recalculateReleaseOrder()` — 3-tier sorting:
   - **Priority 1**: Characters with `source.pageUrl` (from Huiji Wiki) keep existing order
   - **Priority 2**: Characters with `rarity` (from Kornblume) sorted by rarity desc → Kornblume Id
   - **Priority 3**: CN Asset-only characters placed at the front (newest first)

---

## `npm run build:names` — Multilingual Names & Rarity

1. Downloads 5-language names from Kornblume + wikiru JP supplement + Fandom KR supplement
2. Matches characters via ArcanistMap's `nameEng` → slug → Kornblume Name bridge
3. Reads character release status from Kornblume's `IsReleased` field, merged with
   manual overrides in `scripts/data/released-overrides.json`
4. Writes `names`, `rarity`, and `isReleased` to matching characters
5. Upgrades `stage` from `"pending-names"` to `"live"` when names are applied
6. Recalculates `releaseOrder` (characters with new rarity get reordered)

---

## Data Files

| File | Source | Purpose |
|---|---|---|
| `scripts/data/ArcanistMap.json` | CN Asset repo | Character existence, variant IDs, skin list |
| `scripts/data/id-map.json` | Generated (one-shot) | wiki→variant ID mapping |
| `scripts/data/pending-characters.json` | Generated | Characters without headicon images |
| `scripts/data/jp-name-overrides.json` | Manual | Kornblume JP name gaps |
| `scripts/data/released-overrides.json` | Manual | Override Kornblume `IsReleased` for late updates |

---

## `released-overrides.json` — Release Status Override

Kornblume's `IsReleased` tracks CN server release. When Kornblume is slow to update
after a character releases on CN, the data lags behind. This file lets you manually
override the status without waiting for Kornblume to catch up.

Format:

```json
[
  { "nameEng": "Ramona", "isReleased": true },
  { "nameEng": "Cheng Heguang", "isReleased": true }
]
```

- `nameEng` matches the Kornblume `Name` field (equivalent to `ArcanistMap.nameEng`).
- `isReleased: true` forces the character to appear even if Kornblume says otherwise.
- `build-names.ts` reads this file and merges it over Kornblume's data before writing
  `isReleased` into `characters.json`.

**When to update**: after a character releases on CN, check Kornblume's data. If the
character still shows `IsReleased: false`, add an entry here. Remove entries once
Kornblume catches up (running `build-names` with a stale override is harmless — the
override wins).

---

## `npm run test:store` — Store Unit Tests

Tests Zustand store logic:

- Character interactions (own / portray up / portray down / un-own / reset)
- Portray ceiling (5 portrays, no cycling)
- Search and filter
- localStorage persistence migration (clamping, type cleaning, legacy format compatibility)
