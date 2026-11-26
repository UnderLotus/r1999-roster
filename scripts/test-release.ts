import assert from "node:assert/strict";

import {
  applyReleaseStatuses,
  parseGlobalCharacters,
  parseReleaseOverrides,
  resolveGlobalIsOnline,
  type GlobalReleaseSnapshot,
  type ReleaseOverrides,
} from "./release-status";
import type { Character } from "./types";

function makeCharacter(
  baseId: number,
  skins: Character["skins"],
  overrides: Partial<Character> = {}
): Character {
  return {
    id: `${baseId}01`,
    name: `Character ${baseId}`,
    baseId,
    releaseOrder: 1,
    enabled: true,
    stage: "live",
    isReleased: false,
    defaultVariant: skins[0].variantId,
    skins,
    ...overrides,
  };
}

function testGlobalIsOnlineResolution(): void {
  const releaseClock = new Date("2026-09-03T10:00:00.000Z");
  const fixtures: readonly [string, unknown, boolean][] = [
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
  for (const [label, value, expected] of fixtures) {
    assert.equal(resolveGlobalIsOnline(value, releaseClock), expected, `isOnline ${label}`);
  }

  // Server-local timestamp uses explicit Global UTC-5 region offset
  assert.equal(
    resolveGlobalIsOnline("2026-09-03 04:59:59", new Date("2026-09-03T09:59:59.000Z")),
    false
  );
  assert.equal(
    resolveGlobalIsOnline("2026-09-03 04:59:59", new Date("2026-09-03T10:00:00.000Z")),
    true
  );

  // Unsupported values and malformed/impossible timestamps fail loudly
  for (const bad of ["2", 2, "2026-09-03T05:00:00Z", "2026-02-30 05:00:00"]) {
    assert.throws(() => resolveGlobalIsOnline(bad, releaseClock));
  }
}

function testSchemaParsing(): void {
  const parsedGlobal = parseGlobalCharacters([
    { id: 1001, isOnline: 1 },
    { id: 1002, isOnline: 0 },
    { id: 1003, isOnline: null },
  ]);
  assert.deepEqual(
    parsedGlobal.map((entry) => entry.isOnline),
    [1, 0, null]
  );
  assert.throws(() => parseGlobalCharacters([{ id: 1001, isOnline: true }]));

  const parsedOverrides = parseReleaseOverrides({
    characters: [{ baseId: 1001, isReleased: false, note: "second half" }],
    skins: [{ variantId: "100103", isReleased: false }],
  });
  assert.equal(parsedOverrides.characters[0]?.baseId, 1001);
  assert.equal(parsedOverrides.skins[0]?.variantId, "100103");
  assert.throws(() =>
    parseReleaseOverrides([{ nameEng: "unstable", isReleased: false }])
  );
}

function testApplyReleaseStatuses(): void {
  const characters: Character[] = [
    makeCharacter(1001, [
      { variantId: "100101", type: "default", skinName: null, skinNameEng: null, isReleased: false },
      { variantId: "100103", type: "skin", skinName: "A", skinNameEng: "A" },
      { variantId: "100104", type: "skin", skinName: "B", skinNameEng: "B", isReleased: false },
      { variantId: "10010001", type: "skin", skinName: "8-digit", skinNameEng: "8-digit" },
    ]),
    makeCharacter(1002, [
      { variantId: "100201", type: "default", skinName: null, skinNameEng: null },
      { variantId: "100203", type: "skin", skinName: "C", skinNameEng: "C", isReleased: false },
    ]),
    makeCharacter(1003, [
      { variantId: "100301", type: "default", skinName: null, skinNameEng: null },
    ], { isReleased: true }),
  ];

  const snapshot: GlobalReleaseSnapshot = {
    characters: [
      { id: 1001, isOnline: "unsupported" },
      { id: 1002, isOnline: 2 },
    ],
    skins: [{ id: 100103 }, { id: 100104 }, { id: 10010001 }],
  };
  const overrides: ReleaseOverrides = {
    characters: [
      { baseId: 1001, isReleased: false },
      { baseId: 1002, isReleased: true },
    ],
    skins: [
      { variantId: "100103", isReleased: false },
      { variantId: "10010001", isReleased: false },
      { variantId: "100203", isReleased: true },
    ],
  };

  const summary = applyReleaseStatuses(characters, snapshot, overrides);

  // Manual overrides short-circuit unsupported Global character values; GL-absent defaults false.
  assert.equal(characters[0].isReleased, false);
  assert.equal(characters[1].isReleased, true);
  assert.equal(characters[2].isReleased, false, "character absent from GL defaults unreleased");

  // Non-skin variants omit isReleased; released skins omit isReleased; unreleased persist false.
  assert.equal(
    Object.prototype.hasOwnProperty.call(characters[0].skins[0], "isReleased"),
    false,
    "default variant strips isReleased under compact contract"
  );
  assert.equal(characters[0].skins[1].isReleased, false, "manual false gates GL-preloaded skin");
  assert.equal(characters[0].skins[2].isReleased, undefined, "GL-present skin is released sparsely");
  assert.equal(characters[0].skins[3].isReleased, false, "manual false gates 8-digit skin");
  assert.equal(characters[1].skins[1].isReleased, undefined, "manual true releases GL-absent skin");
  assert.equal(summary.releasedCharacters, 1);
  assert.equal(summary.unreleasedCharacters, 2);
  assert.equal(summary.releasedSkins, 2);
  assert.equal(summary.unreleasedSkins, 2);

  // Rerunning with identical inputs is idempotent.
  const rerun = applyReleaseStatuses(characters, snapshot, overrides);
  assert.equal(rerun.characterChanges, 0);
  assert.equal(rerun.skinChanges, 0);

  // Stale character/skin overrides and duplicate override IDs fail before mutating characters.
  const beforeError = structuredClone(characters);
  assert.throws(
    () =>
      applyReleaseStatuses(characters, snapshot, {
        characters: [{ baseId: 9999, isReleased: false }],
        skins: [],
      }),
    /does not match local baseId: 9999/
  );
  assert.deepEqual(characters, beforeError, "stale character override leaves characters untouched");

  assert.throws(
    () =>
      applyReleaseStatuses(characters, snapshot, {
        characters: [],
        skins: [{ variantId: "999903", isReleased: false }],
      }),
    /does not match local variantId: 999903/
  );
  assert.deepEqual(characters, beforeError, "stale skin override leaves characters untouched");

  assert.throws(
    () =>
      applyReleaseStatuses(characters, snapshot, {
        characters: [
          { baseId: 1001, isReleased: false },
          { baseId: 1001, isReleased: true },
        ],
        skins: [],
      }),
    /Duplicate character override baseId/
  );
}

testGlobalIsOnlineResolution();
testSchemaParsing();
testApplyReleaseStatuses();

console.log("Release status checks passed.");
