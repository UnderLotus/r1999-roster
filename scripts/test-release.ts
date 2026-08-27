import {
  applyReleaseStatuses,
  parseGlobalCharacters,
  parseReleaseOverrides,
  resolveGlobalIsOnline,
  type GlobalReleaseSnapshot,
  type ReleaseOverrides,
} from "./release-status";
import type { Character } from "./types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`ok: ${message}`);
}

function assertThrows(run: () => void, message: string): void {
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  assert(threw, message);
}

const releaseClock = new Date("2026-09-03T10:00:00.000Z");
const globalIsOnlineFixtures: readonly [string, unknown, boolean][] = [
  ["numeric 1", 1, true],
  ["string 1", "1", true],
  ["numeric 0", 0, false],
  ["string 0", "0", false],
  ["empty", "", false],
  ["null", null, false],
  ["missing", undefined, false],
  ["past timestamp", "2026-09-03 04:59:59", true],
  ["future timestamp", "2026-09-03 05:00:01", false],
  ["equal timestamp", "2026-09-03 05:00:00", false],
];
for (const [label, value, expected] of globalIsOnlineFixtures) {
  assert(
    resolveGlobalIsOnline(value, releaseClock) === expected,
    `isOnline ${label}`
  );
}
assert(
  !resolveGlobalIsOnline(
    "2026-09-03 04:59:59",
    new Date("2026-09-03T09:59:59.000Z")
  ) &&
    resolveGlobalIsOnline(
      "2026-09-03 04:59:59",
      new Date("2026-09-03T10:00:00.000Z")
    ),
  "server-local timestamp conversion uses the explicit region offset"
);
assertThrows(
  () => resolveGlobalIsOnline("2", releaseClock),
  "unknown string isOnline fails loudly"
);
assertThrows(
  () => resolveGlobalIsOnline(2, releaseClock),
  "unknown numeric isOnline fails loudly"
);
assertThrows(
  () => resolveGlobalIsOnline("2026-09-03T05:00:00Z", releaseClock),
  "non-Global timestamp syntax fails loudly"
);
assertThrows(
  () => resolveGlobalIsOnline("2026-02-30 05:00:00", releaseClock),
  "invalid Global timestamp calendar date fails loudly"
);
const parsedGlobalCharacters = parseGlobalCharacters([
  { id: 1001, isOnline: 1 },
  { id: 1002, isOnline: 0 },
  { id: 1003, isOnline: null },
]);
assert(
  parsedGlobalCharacters[0]?.isOnline === 1 &&
    parsedGlobalCharacters[1]?.isOnline === 0 &&
    parsedGlobalCharacters[2]?.isOnline === null,
  "Global character schema preserves numeric and null isOnline values"
);
assertThrows(
  () => parseGlobalCharacters([{ id: 1001, isOnline: true }]),
  "Global character schema rejects unrelated isOnline types"
);

const parsed = parseReleaseOverrides({
  characters: [{ baseId: 1001, isReleased: false, note: "second half" }],
  skins: [{ variantId: "100103", isReleased: false }],
});
assert(parsed.characters[0]?.baseId === 1001, "ID-based character override parses");
assert(parsed.skins[0]?.variantId === "100103", "ID-based skin override parses");
assertThrows(
  () => parseReleaseOverrides([{ nameEng: "unstable", isReleased: false }]),
  "legacy name-based override schema is rejected"
);

const characters: Character[] = [
  {
    id: "100101",
    name: "Preloaded",
    baseId: 1001,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: false,
    defaultVariant: "100101",
    skins: [
      { variantId: "100101", type: "default", skinName: null, skinNameEng: null },
      { variantId: "100103", type: "skin", skinName: "A", skinNameEng: "A" },
      {
        variantId: "100104",
        type: "skin",
        skinName: "B",
        skinNameEng: "B",
        isReleased: false,
      },
    ],
  },
  {
    id: "100201",
    name: "Manual Release",
    baseId: 1002,
    releaseOrder: 2,
    enabled: true,
    stage: "live",
    isReleased: false,
    defaultVariant: "100201",
    skins: [
      { variantId: "100201", type: "default", skinName: null, skinNameEng: null },
      {
        variantId: "100203",
        type: "skin",
        skinName: "C",
        skinNameEng: "C",
        isReleased: false,
      },
    ],
  },
];
const snapshot: GlobalReleaseSnapshot = {
  characters: [
    { id: 1001, isOnline: "unsupported" },
    { id: 1002, isOnline: 2 },
  ],
  skins: [{ id: 100103 }, { id: 100104 }],
};
const overrides: ReleaseOverrides = {
  characters: [
    { baseId: 1001, isReleased: false },
    { baseId: 1002, isReleased: true },
  ],
  skins: [
    { variantId: "100103", isReleased: false },
    { variantId: "100203", isReleased: true },
  ],
};
const summary = applyReleaseStatuses(characters, snapshot, overrides);
assert(
  !characters[0]!.isReleased,
  "manual false short-circuits unsupported Global character value"
);
assert(
  characters[1]!.isReleased,
  "manual true short-circuits unsupported Global character value"
);
assert(characters[0]!.skins[1]!.isReleased === false, "manual false gates GL-preloaded skin");
assert(characters[0]!.skins[2]!.isReleased === undefined, "GL-present skin is released sparsely");
assert(characters[1]!.skins[1]!.isReleased === undefined, "manual true releases GL-absent skin");
assert(summary.releasedCharacters === 1 && summary.unreleasedSkins === 1, "summary reflects final states");

assertThrows(
  () =>
    applyReleaseStatuses(characters, snapshot, {
      characters: [{ baseId: 9999, isReleased: false }],
      skins: [],
    }),
  "stale character override fails before mutation"
);
