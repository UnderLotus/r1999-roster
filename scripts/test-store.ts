// Node 環境的 localStorage mock（在 import store 前設定）
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

import { useBoxStore, migratePersistedState, migratePersisted } from "../src/store/boxStore";
import { characters as charactersData } from "../src/data/characters";
import { reconcileBox, type BoxState } from "../src/domain/box";
import { resolveModeVariant } from "../src/utils/skins";

const store = useBoxStore;
const s = () => store.getState();
const realCharacter = charactersData.find((character) => character.isReleased !== false)!;
const realId = realCharacter.id;

function assert(cond: boolean, msg: string) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
}

// 初始狀態
assert(Object.keys(s().characters).length === 0, "初始無角色");

// 升塑：未持有 → 0塑
s().activateCharacter("A");
assert(s().characters["A"]?.owned === true, "第一次點擊變持有");
assert(s().characters["A"]?.portray === 0, "第一次點擊 0 塑");

// 升塑到 5
for (let i = 0; i < 5; i++) s().activateCharacter("A");
assert(s().characters["A"]?.portray === 5, "升到 5 塑");

// 5 塑再點維持（不循環）
s().activateCharacter("A");
assert(s().characters["A"]?.owned === true, "5 塑再點仍持有");
assert(s().characters["A"]?.portray === 5, "5 塑再點維持 5 塑（不循環）");

// 減塑
s().activateCharacter("A");
s().activateCharacter("A");
s().activateCharacter("A");
s().activateCharacter("A");
s().activateCharacter("A"); // 現在 5 塑
s().decreasePortray("A");
assert(s().characters["A"]?.portray === 4, "減塑 5→4");

// 0 塑減塑 → 取消持有
const st = s().characters["A"];
if (st) {
  s().decreasePortray("A");
  s().decreasePortray("A");
  s().decreasePortray("A");
  s().decreasePortray("A");
}
assert(s().characters["A"]?.portray === 0, "減塑到 0");
s().decreasePortray("A");
assert(s().characters["A"] === undefined, "0 塑再按 − 取消持有");

// 未持有角色減塑無效
s().decreasePortray("X");
assert(s().characters["X"] === undefined, "未持有角色減塑無效");

// 取消持有（0 塑再按 −）
s().decreasePortray("A");
assert(s().characters["A"] === undefined, "取消持有後移除");

// 重設
s().activateCharacter("B");
s().activateCharacter("C");
s().resetAll();
assert(Object.keys(s().characters).length === 0, "重設清空所有");

// setters
s().setFilterMode("owned");
assert(s().filterMode === "owned", "setFilterMode owned");
s().setSearch("測試");
assert(s().search === "測試", "setSearch");

/* ---------- defaultSkinMode / customVariants ---------- */

// 初始為 initial
assert(s().defaultSkinMode === "initial", "defaultSkinMode 預設 initial");

// setActiveVariant 標記 custom
s().activateCharacter("A");
s().setActiveVariant("A", "100001");
assert(s().customVariants["A"] === true, "setActiveVariant 標記 custom");

// decreasePortray 歸零後取消持有也清除 custom（取代已移除的 removeCharacter）
s().activateCharacter("B");
s().setActiveVariant("B", "100002");
s().decreasePortray("B");
assert(s().customVariants["B"] === undefined, "減塑歸零取消持有清除 custom");

// resetAll 清除全部 custom
s().setActiveVariant("B", "100002");
s().resetAll();
assert(Object.keys(s().customVariants).length === 0, "resetAll 清除全部 custom");

// setSkinMode 切換模式
s().setSkinMode("insight");
assert(s().defaultSkinMode === "insight", "setSkinMode → insight");
s().setSkinMode("initial");
assert(s().defaultSkinMode === "initial", "setSkinMode → initial");

// setSkinMode 跳過 custom 角色、更新其餘角色
s().activateCharacter("A");
s().setActiveVariant("A", "100002");
s().setSkinMode("insight");
for (const c of charactersData) {
  if (s().customVariants[c.id]) {
    assert(s().activeVariant[c.id] === "100002", `custom 角色不受 setSkinMode 影響 (${c.id})`);
  } else {
    assert(
      s().activeVariant[c.id] === resolveModeVariant(c, "insight"),
      `setSkinMode 更新非 custom 角色 (${c.id})`
    );
  }
}
s().setSkinMode("initial");

/* ---------- importBox ---------- */

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
  characters: {
    [importedCharacter.id]: { owned: true, portray: 0 },
  },
  activeVariant: {},
  customVariants: {},
  defaultSkinMode: "insight",
  showFutureSight: true,
});
assert(
  s().characters[importedCharacter.id]?.portray === 0,
  "importBox 保留 0 塑持有角色"
);
assert(
  s().characters[replacedCharacter.id] === undefined,
  "importBox 覆蓋舊 Box 角色"
);
assert(
  s().userId === "keep-me" &&
    s().filterMode === "owned" &&
    s().search === "keep-search" &&
    s().rarityFilter.length === 1 &&
    s().rarityFilter[0] === 6 &&
    s().displayLang === "zh-TW" &&
    s().langChosen === true,
  "importBox 保留 ID、語系、搜尋與篩選偏好"
);
assert(
  s().defaultSkinMode === "insight" && s().showFutureSight === true,
  "importBox 套用立繪模式與未來視"
);

/* ---------- migrate 驗證 ---------- */

// 正常資料
const ok = migratePersistedState({
  characters: {
    [realId]: { owned: true, portray: 3 },
  },
});
assert(ok.characters?.[realId].portray === 3, "migrate 保留正常值");

// clamp
assert(
  migratePersistedState({ characters: { [realId]: { owned: true, portray: 99 } } })
    .characters?.[realId].portray === 5,
  "migrate clamp portray 99→5"
);
assert(
  migratePersistedState({ characters: { [realId]: { owned: true, portray: -3 } } })
    .characters?.[realId].portray === 0,
  "migrate clamp 負數→0"
);

// owned false 不保留（store invariant：未持有不存 characters）
assert(
  migratePersistedState({ characters: { [realId]: { owned: false, portray: 3 } } })
    .characters?.[realId] === undefined,
  "migrate owned false 不保留"
);

// 字串 owned "false" 不當 true（也不保留）
assert(
  migratePersistedState({
    characters: { [realId]: { owned: "false" as never, portray: 3 } },
  }).characters?.[realId] === undefined,
  "migrate 字串 owned false 不誤判"
);

// Primitive adapter 只處理 shape；catalog legality 由 Box reconciliation 決定。
assert(
  migratePersistedState({
    characters: { "999901": { owned: true, portray: 3 } },
  }).characters?.["999901"]?.portray === 3,
  "primitive migrate 保留未知角色供 domain reconciliation"
);
assert(
  migratePersisted(
    { characters: { "999901": { owned: true, portray: 3 } } },
    8
  ).characters?.["999901"] === undefined,
  "hydration reconciliation 移除未知角色 ID"
);

// 小數/字串/Infinity portray → 0
assert(
  migratePersistedState({
    characters: { [realId]: { owned: true, portray: 2.5 } },
  }).characters?.[realId].portray === 0,
  "migrate 小數 portray → 0"
);
assert(
  migratePersistedState({
    characters: { [realId]: { owned: true, portray: "3" as never } },
  }).characters?.[realId].portray === 0,
  "migrate 字串 portray → 0"
);
assert(
  migratePersistedState({
    characters: { [realId]: { owned: true, portray: Infinity } },
  }).characters?.[realId].portray === 0,
  "migrate Infinity portray → 0"
);

// malformed 資料
assert(
  Object.keys(migratePersistedState(null).characters ?? {}).length === 0,
  "migrate null → 空"
);
assert(
  Object.keys(migratePersistedState(undefined).characters ?? {}).length === 0,
  "migrate undefined → 空"
);
assert(
  Object.keys(migratePersistedState({ characters: null }).characters ?? {})
    .length === 0,
  "migrate characters null → 空"
);
assert(
  Object.keys(migratePersistedState({ characters: "invalid" }).characters ?? {})
    .length === 0,
  "migrate characters 字串 → 空"
);
assert(
  Object.keys(migratePersistedState({ characters: [1, 2, 3] }).characters ?? {})
    .length === 0,
  "migrate characters 陣列 → 空"
);
assert(
  Object.keys(
    migratePersistedState({
      characters: { A: "invalid" },
    }).characters ?? {}
  ).length === 0,
  "migrate 角色狀態非物件 → 跳過"
);

/* ---------- migrate：variant 校驗 ---------- */

const realVariant = realCharacter.skins[0].variantId;
const parsedVariants = migratePersistedState({
  activeVariant: { [realId]: realVariant, X: "12345", invalid: 123 },
}) as { activeVariant?: Record<string, string> };
assert(
  parsedVariants.activeVariant?.[realId] === realVariant &&
    parsedVariants.activeVariant?.X === "12345" &&
    parsedVariants.activeVariant?.invalid === undefined,
  "primitive migrate 只過濾非字串 variant，legality 留給 domain"
);

/* ---------- migrate：langChosen ---------- */

// 舊資料（無 langChosen 欄位）→ 視為已選擇（true）
const oldMigrated = migratePersistedState({ displayLang: "en-US" });
assert(oldMigrated.langChosen === false, "migratePersistedState 無 langChosen → false（新訪客）");
// 注意：migrate 函數本身（version <7）才會把舊資料視為 true，這裡測 normalize 的原始行為

/* ---------- migratePersisted：version 分支 ---------- */

// version 0–6（有 persisted 舊資料）→ langChosen 一律 true
for (const v of [0, 5, 6]) {
  const m = migratePersisted({ displayLang: "zh-TW" }, v);
  assert(m.langChosen === true, `migratePersisted version ${v} → langChosen true（舊資料視為已選擇）`);
}
// version 7+ → 尊重已存的 langChosen
const m7 = migratePersisted({ displayLang: "zh-TW", langChosen: false }, 7);
assert(m7.langChosen === false, "migratePersisted version 7 尊重 langChosen false");
const m8 = migratePersisted({ displayLang: "zh-TW", langChosen: true }, 8);
assert(m8.langChosen === true, "migratePersisted version 8 尊重 langChosen true");
// 無 version（全新訪客）→ false
const mNull = migratePersisted({ displayLang: "zh-TW" }, undefined);
assert(mNull.langChosen === false, "migratePersisted 無 version → langChosen false（全新訪客）");
// version <6 → activeVariant 清空（v5→v6 遷移規則）
const m5 = migratePersisted({ displayLang: "en-US", activeVariant: { X: "123" } }, 5);
assert(Object.keys(m5.activeVariant ?? {}).length === 0, "migratePersisted version 5 清空 activeVariant");
// version >=6 → 為持有角色保留合法 activeVariant
const m6 = migratePersisted(
  {
    characters: { [realId]: { owned: true, portray: 0 } },
    activeVariant: { [realId]: realVariant },
  },
  6
) as { activeVariant?: Record<string, string> };
assert(m6.activeVariant?.[realId] === realVariant, "migratePersisted version 6 保留合法 activeVariant");

// v7 → v8：現役 v7 使用者 bump 後觸發 migrate，KNOWN_IDS 過濾 stale 未知角色
assert(
  migratePersisted(
    {
      characters: {
        [realId]: { owned: true, portray: 2 },
        "999901": { owned: true, portray: 3 }, // stale unknown ID
        "999902": { owned: false, portray: 5 }, // 未持有也不該留存
      },
      activeVariant: { [realId]: realVariant },
    },
    7
  ).characters?.[realId]?.portray === 2,
  "migrate v7→v8：已知角色保留（portray 2）"
);
assert(
  migratePersisted(
    {
      characters: {
        "999901": { owned: true, portray: 3 },
      },
    },
    7
  ).characters?.["999901"] === undefined,
  "migrate v7→v8：未知角色 ID 被清掉"
);
assert(
  migratePersisted(
    {
      characters: {
        "999902": { owned: false, portray: 5 },
      },
    },
    7
  ).characters?.["999902"] === undefined,
  "migrate v7→v8：未持有條目不保留"
);

// ===== Future Sight hydration / transition parity =====

const unreleasedSkinCase = charactersData.find(
  (character) =>
    character.isReleased !== false &&
    character.skins.some((skin) => skin.isReleased === false)
);
const unreleasedCharacter = charactersData.find(
  (character) => character.isReleased === false
);
const releasedCharacters = charactersData.filter(
  (character) => character.isReleased !== false
);
const missingVariantCharacter = releasedCharacters.find(
  (character) => character.id !== unreleasedSkinCase?.id
);
const releasedCustomCharacter = releasedCharacters.find(
  (character) =>
    character.id !== unreleasedSkinCase?.id &&
    character.id !== missingVariantCharacter?.id &&
    character.skins.some((skin) => skin.isReleased !== false)
);

assert(Boolean(unreleasedSkinCase), "fixture：存在已實裝角色含未實裝 skin");
assert(Boolean(unreleasedCharacter), "fixture：存在未實裝角色");
assert(Boolean(missingVariantCharacter), "fixture：存在缺少 activeVariant 的已實裝角色");
assert(Boolean(releasedCustomCharacter), "fixture：存在可保留 released custom skin 的角色");

if (
  unreleasedSkinCase &&
  unreleasedCharacter &&
  missingVariantCharacter &&
  releasedCustomCharacter
) {
  const repairedId = unreleasedSkinCase.id;
  const unreleasedVariant = unreleasedSkinCase.skins.find(
    (skin) => skin.isReleased === false
  )!.variantId;
  const releasedCustomVariant = releasedCustomCharacter.skins.find(
    (skin) => skin.isReleased !== false
  )!.variantId;

  // Shared-import regression from LOC-63 remains protected.
  const importPayload: BoxState = {
    characters: { [repairedId]: { owned: true, portray: 0 } },
    activeVariant: { [repairedId]: unreleasedVariant },
    customVariants: { [repairedId]: true },
    defaultSkinMode: "insight",
    showFutureSight: false,
  };
  s().importBox(importPayload);
  assert(
    s().activeVariant[repairedId] !== unreleasedVariant &&
      s().customVariants[repairedId] === undefined,
    "匯入(FS off)：incoming 未實裝 skin 由 Box model 修復"
  );
  s().importBox({ ...importPayload, showFutureSight: true });
  assert(
    s().activeVariant[repairedId] === unreleasedVariant,
    "匯入(FS on)：保留合法未實裝 skin"
  );

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
      [unreleasedCharacter.id]: unreleasedCharacter.skins[0].variantId,
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

  // Current-version storage does not call Zustand's migrate callback. Exercise
  // the real hydration path so the merge boundary must reconcile v9 data too.
  const expectedV9Box = reconcileBox(invalidBox, charactersData);
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
  const rehydratedV9Box: BoxState = {
    characters: s().characters,
    activeVariant: s().activeVariant,
    customVariants: s().customVariants,
    defaultSkinMode: s().defaultSkinMode,
    showFutureSight: s().showFutureSight,
  };
  assert(
    JSON.stringify(rehydratedV9Box) === JSON.stringify(expectedV9Box),
    "current v9 persist.rehydrate 經 Box model reconciliation"
  );
  assert(
    s().characters[unreleasedCharacter.id] === undefined &&
      s().characters["999901"] === undefined &&
      s().activeVariant[repairedId] === `${unreleasedSkinCase.baseId}01` &&
      s().customVariants[repairedId] === undefined &&
      s().activeVariant[missingVariantCharacter.id] ===
        `${missingVariantCharacter.baseId}01`,
    "v9 hydration 移除 stale/unreleased 並修復 invalid/missing variant"
  );
  assert(
    s().userId === "hydrate-user" &&
      s().displayLang === "zh-TW" &&
      s().langChosen === true,
    "v9 hydration 套用 persisted allowlist preferences"
  );
  assert(
    s().filterMode === "unowned" &&
      s().search === "keep-current-search" &&
      s().rarityFilter.length === 1 &&
      s().rarityFilter[0] === 5 &&
      s().activateCharacter === activateBeforeHydration,
    "v9 hydration 保留 non-persisted UI state 與 actions"
  );

  const hydrated = migratePersisted(persistedState, 8);
  const hydratedBox: BoxState = {
    characters: hydrated.characters ?? {},
    activeVariant: (hydrated.activeVariant ?? {}) as Record<string, string>,
    customVariants: (hydrated.customVariants ?? {}) as Record<string, true>,
    defaultSkinMode: hydrated.defaultSkinMode as "initial" | "insight",
    showFutureSight: hydrated.showFutureSight === true,
  };

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

  const transitionedBox: BoxState = {
    characters: s().characters,
    activeVariant: s().activeVariant,
    customVariants: s().customVariants,
    defaultSkinMode: s().defaultSkinMode,
    showFutureSight: s().showFutureSight,
  };
  assert(
    JSON.stringify(transitionedBox) === JSON.stringify(hydratedBox),
    "相同 invalid Box 經 hydration 與 FS-off transition 得到相同結果"
  );
  assert(transitionCount === 1, "FS-off 只觸發一次 Zustand state transition");
  assert(
    s().characters[unreleasedCharacter.id] === undefined &&
      s().activeVariant[unreleasedCharacter.id] === undefined &&
      s().customVariants[unreleasedCharacter.id] === undefined,
    "FS-off 原子移除未實裝角色及其 variant/custom"
  );
  assert(
    s().activeVariant[repairedId] === `${unreleasedSkinCase.baseId}01` &&
      s().customVariants[repairedId] === undefined,
    "FS-off 修復未實裝 skin 並清 custom"
  );
  assert(
    s().activeVariant[missingVariantCharacter.id] ===
      `${missingVariantCharacter.baseId}01`,
    "Box model 補齊 missing activeVariant"
  );
  assert(
    s().activeVariant[releasedCustomCharacter.id] === releasedCustomVariant &&
      s().customVariants[releasedCustomCharacter.id] === true,
    "FS-off 保留 released custom skin"
  );
  assert(
    s().userId === "keep-user",
    "FS-off transition 保留非 Box preference"
  );
}

console.log(process.exitCode ? "\n有失敗項目" : "\n全部通過");
