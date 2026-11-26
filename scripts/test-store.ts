import assert from "node:assert/strict";

// Install localStorage mock BEFORE importing boxStore so Zustand's initial persist
// hydration never hits Node's unconfigured global localStorage getter.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(index: number) {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

const memoryStorage = new MemoryStorage();
(globalThis as { localStorage?: Storage }).localStorage = memoryStorage;

const [
  {
    useBoxStore,
    migratePersistedState,
    migratePersisted,
    partializeBoxStore,
    USER_ID_MAX,
  },
  { characters: charactersData },
  { reconcileBox },
  { resolveModeVariant },
] = await Promise.all([
  import("../src/store/boxStore"),
  import("../src/data/characters"),
  import("../src/domain/box"),
  import("../src/utils/skins"),
]);

import type { BoxState } from "../src/domain/box";

const store = useBoxStore;
const s = () => store.getState();

function testPortrayAndResetLifecycle(): void {
  store.getState().resetAll();
  assert.deepEqual(s().characters, {}, "initial box has no owned characters");

  // Unowned -> 0 -> ... -> 5 (capped, does not wrap)
  s().activateCharacter("A");
  assert.deepEqual(s().characters["A"], { owned: true, portray: 0 });
  for (let i = 0; i < 6; i++) s().activateCharacter("A");
  assert.deepEqual(s().characters["A"], { owned: true, portray: 5 });

  // Decrease 5 -> 4 -> ... -> 0 -> unowned (also clears activeVariant & customVariants)
  s().setActiveVariant("A", "100001");
  assert.equal(s().customVariants["A"], true);
  s().decreasePortray("A");
  assert.equal(s().characters["A"]?.portray, 4);
  for (let i = 0; i < 4; i++) s().decreasePortray("A");
  assert.equal(s().characters["A"]?.portray, 0);
  s().decreasePortray("A");
  assert.equal(s().characters["A"], undefined);
  assert.equal(s().activeVariant["A"], undefined);
  assert.equal(s().customVariants["A"], undefined);

  // Decreasing an unowned character is a no-op
  s().decreasePortray("X");
  assert.equal(s().characters["X"], undefined);

  // resetAll clears Box state while preserving preferences
  s().activateCharacter("B");
  s().setActiveVariant("B", "100002");
  s().setUserId("keep-user");
  s().setDisplayLang("zh-TW");
  s().setFilterMode("owned");
  s().resetAll();
  assert.deepEqual(s().characters, {});
  assert.deepEqual(s().activeVariant, {});
  assert.deepEqual(s().customVariants, {});
  assert.equal(s().userId, "keep-user");
  assert.equal(s().displayLang, "zh-TW");
  assert.equal(s().filterMode, "owned");
}

function testSkinModeRespectsCustomVariants(): void {
  const [customCharacter, modeCharacter] = charactersData.filter(
    (character) =>
      character.isReleased !== false &&
      resolveModeVariant(character, "initial") !== resolveModeVariant(character, "insight")
  );
  assert.ok(
    customCharacter && modeCharacter,
    "fixture requires two released characters with distinct initial/insight variants"
  );

  s().resetAll();
  s().setSkinMode("initial");
  const customVariant = resolveModeVariant(customCharacter, "initial");
  s().activateCharacter(customCharacter.id);
  s().setActiveVariant(customCharacter.id, customVariant);

  s().setSkinMode("insight");
  assert.equal(s().defaultSkinMode, "insight");
  assert.equal(
    s().activeVariant[customCharacter.id],
    customVariant,
    "setSkinMode preserves custom variant selection"
  );
  assert.equal(
    s().activeVariant[modeCharacter.id],
    resolveModeVariant(modeCharacter, "insight"),
    "setSkinMode updates non-custom characters"
  );
  s().setSkinMode("initial");
}

function testPartializeAllowlist(): void {
  const projected = partializeBoxStore({
    ...s(),
    filterMode: "owned",
    search: "transient query",
    rarityFilter: [6],
  });
  assert.deepEqual(Object.keys(projected).sort(), [
    "activeVariant",
    "characters",
    "customVariants",
    "defaultSkinMode",
    "displayLang",
    "langChosen",
    "showFutureSight",
    "userId",
  ]);
}

function testImportBoxAndPreferences(): void {
  const importedCharacter = charactersData[0];
  const replacedCharacter = charactersData[1];
  s().resetAll();
  s().activateCharacter(replacedCharacter.id);
  s().setUserId("keep-me");
  s().setFilterMode("owned");
  s().setSearch("keep-search");
  s().setRarityFilter([6]);
  s().setDisplayLang("zh-TW");

  s().importBox({
    characters: { [importedCharacter.id]: { owned: true, portray: 0 } },
    activeVariant: {},
    customVariants: {},
    defaultSkinMode: "insight",
    showFutureSight: true,
  });

  assert.equal(s().characters[importedCharacter.id]?.portray, 0);
  assert.equal(s().characters[replacedCharacter.id], undefined);
  assert.equal(s().defaultSkinMode, "insight");
  assert.equal(s().showFutureSight, true);
  assert.equal(s().userId, "keep-me");
  assert.equal(s().filterMode, "owned");
  assert.equal(s().search, "keep-search");
  assert.deepEqual(s().rarityFilter, [6]);
  assert.equal(s().displayLang, "zh-TW");
  assert.equal(s().langChosen, true);
}

function testPersistedSanitizationAndMigrations(): void {
  const realCharacter = charactersData.find((character) => character.isReleased !== false);
  assert.ok(realCharacter, "catalog contains a released character");
  const realId = realCharacter.id;
  const realVariant = realCharacter.defaultVariant;

  for (const [portray, expected] of [
    [3, 3],
    [99, 5],
    [-3, 0],
  ] as const) {
    assert.equal(
      migratePersistedState({ characters: { [realId]: { owned: true, portray } } })
        .characters?.[realId]?.portray,
      expected
    );
  }
  assert.deepEqual(
    migratePersistedState({ characters: { [realId]: { owned: false, portray: 3 } } }).characters,
    {}
  );
  assert.deepEqual(migratePersistedState(null).characters, {});
  assert.equal(
    migratePersistedState({ userId: `   ${"x".repeat(USER_ID_MAX + 5)}   ` }).userId,
    "x".repeat(USER_ID_MAX),
    "persisted userId is trimmed and truncated to USER_ID_MAX"
  );
  assert.equal(
    migratePersistedState({ displayLang: "invalid-locale" }).displayLang,
    "en-US",
    "invalid persisted displayLang falls back to en-US"
  );

  // Version migration branches
  assert.equal(
    migratePersisted({ displayLang: "zh-TW" }, undefined).langChosen,
    false,
    "fresh visitor (no version) keeps langChosen false"
  );
  assert.deepEqual(
    migratePersisted(
      {
        characters: { [realId]: { owned: true, portray: 0 } },
        activeVariant: { [realId]: realVariant },
        customVariants: { [realId]: true },
        defaultSkinMode: "insight",
      },
      5
    ).customVariants,
    {},
    "v5->v6 drops legacy variant selections"
  );
  assert.equal(
    migratePersisted({ defaultSkinMode: "insight" }, 5).defaultSkinMode,
    "initial",
    "v5->v6 resets skinMode to initial"
  );
  const m6 = migratePersisted(
    {
      displayLang: "zh-TW",
      characters: { [realId]: { owned: true, portray: 0 } },
      activeVariant: { [realId]: realVariant },
    },
    6
  );
  assert.equal(m6.langChosen, true, "v6 treats existing persisted language as chosen");
  assert.equal((m6.activeVariant as Record<string, string>)?.[realId], realVariant);

  const m7 = migratePersisted(
    {
      displayLang: "zh-TW",
      langChosen: false,
      characters: {
        [realId]: { owned: true, portray: 2 },
        "999901": { owned: true, portray: 3 },
        "999902": { owned: false, portray: 5 },
      },
    },
    7
  );
  assert.equal(m7.langChosen, false, "v7+ respects persisted langChosen");
  assert.deepEqual(m7.characters, { [realId]: { owned: true, portray: 2 } });
}

async function testFutureSightHydrationAndTransition(): Promise<void> {
  // Test-local release flags keep Future Sight behavior independent of the live
  // release schedule; reconciliation still runs against the actual catalog.
  const [unreleasedSkinCase, missingVariantCharacter, releasedCustomCharacter, unreleasedCharacter] =
    charactersData.filter((character) => character.skins.length > 1);
  assert.ok(
    unreleasedSkinCase && missingVariantCharacter && releasedCustomCharacter && unreleasedCharacter,
    "fixture requires four actual Characters with multiple Variants"
  );

  const unreleasedVariant = unreleasedSkinCase.skins.find(
    (skin) => skin.variantId !== unreleasedSkinCase.defaultVariant
  )!.variantId;
  unreleasedSkinCase.isReleased = true;
  unreleasedSkinCase.skins.find(
    (skin) => skin.variantId === unreleasedVariant
  )!.isReleased = false;
  missingVariantCharacter.isReleased = true;
  releasedCustomCharacter.isReleased = true;
  const releasedCustomVariant = releasedCustomCharacter.defaultVariant;
  unreleasedCharacter.isReleased = false;

  const repairedId = unreleasedSkinCase.id;

  // Shared-import routes through reconcileBox for FS off vs on
  const importPayload: BoxState = {
    characters: { [repairedId]: { owned: true, portray: 0 } },
    activeVariant: { [repairedId]: unreleasedVariant },
    customVariants: { [repairedId]: true },
    defaultSkinMode: "insight",
    showFutureSight: false,
  };
  s().importBox(importPayload);
  assert.notEqual(s().activeVariant[repairedId], unreleasedVariant);
  assert.equal(s().customVariants[repairedId], undefined);
  s().importBox({ ...importPayload, showFutureSight: true });
  assert.equal(s().activeVariant[repairedId], unreleasedVariant);

  const invalidBox: BoxState = {
    characters: {
      [repairedId]: { owned: true, portray: 2 },
      [missingVariantCharacter.id]: { owned: true, portray: 1 },
      [releasedCustomCharacter.id]: { owned: true, portray: 4 },
      [unreleasedCharacter.id]: { owned: true, portray: 3 },
      "999901": { owned: true, portray: 5 },
    },
    activeVariant: {
      [repairedId]: unreleasedVariant,
      [releasedCustomCharacter.id]: releasedCustomVariant,
      [unreleasedCharacter.id]: unreleasedCharacter.defaultVariant,
      "999901": "999901",
    },
    customVariants: {
      [repairedId]: true,
      [releasedCustomCharacter.id]: true,
      [unreleasedCharacter.id]: true,
      "999901": true,
    },
    defaultSkinMode: "initial",
    showFutureSight: false,
  };
  const persistedState = {
    ...invalidBox,
    displayLang: "zh-TW",
    userId: "hydrate-user",
    langChosen: true,
  };

  // Current-version v9 persist.rehydrate still reconciles through merge boundary
  const expectedReconciled = reconcileBox(invalidBox, charactersData);
  store.setState({
    filterMode: "unowned",
    search: "keep-current-search",
    rarityFilter: [5],
  });
  const activateBeforeHydration = s().activateCharacter;
  memoryStorage.setItem(
    "reverse1999-box-state",
    JSON.stringify({ state: persistedState, version: 9 })
  );
  await store.persist.rehydrate();

  assert.deepEqual(
    {
      characters: s().characters,
      activeVariant: s().activeVariant,
      customVariants: s().customVariants,
      defaultSkinMode: s().defaultSkinMode,
      showFutureSight: s().showFutureSight,
    },
    expectedReconciled,
    "v9 persist.rehydrate reconciles Box identically to reconcileBox"
  );
  assert.equal(s().activeVariant[repairedId], unreleasedSkinCase.defaultVariant);
  assert.equal(
    s().activeVariant[missingVariantCharacter.id],
    missingVariantCharacter.defaultVariant
  );
  assert.equal(s().userId, "hydrate-user");
  assert.equal(s().displayLang, "zh-TW");
  assert.equal(s().langChosen, true);
  assert.equal(s().filterMode, "unowned");
  assert.equal(s().search, "keep-current-search");
  assert.deepEqual(s().rarityFilter, [5]);
  assert.equal(s().activateCharacter, activateBeforeHydration);

  // FS-off transition is a single atomic Zustand update matching hydration
  store.setState({
    ...invalidBox,
    showFutureSight: true,
    userId: "keep-user",
  });
  let transitionCount = 0;
  const unsubscribe = store.subscribe(() => {
    transitionCount++;
  });
  s().setShowFutureSight(false);
  unsubscribe();

  assert.equal(transitionCount, 1, "FS-off emits exactly one Zustand state transition");
  assert.deepEqual(
    {
      characters: s().characters,
      activeVariant: s().activeVariant,
      customVariants: s().customVariants,
      defaultSkinMode: s().defaultSkinMode,
      showFutureSight: s().showFutureSight,
    },
    expectedReconciled
  );
  assert.equal(s().userId, "keep-user");

  // CMP-08: toggling FS back ON does not restore previously dropped unreleased entries
  s().setShowFutureSight(true);
  assert.equal(s().characters[unreleasedCharacter.id], undefined);
  assert.equal(s().activeVariant[repairedId], unreleasedSkinCase.defaultVariant);
  assert.equal(s().customVariants[repairedId], undefined);
}

testPortrayAndResetLifecycle();
testSkinModeRespectsCustomVariants();
testPartializeAllowlist();
testImportBoxAndPreferences();
testPersistedSanitizationAndMigrations();
await testFutureSightHydrationAndTransition();

console.log("Store lifecycle, migration, and hydration checks passed.");
