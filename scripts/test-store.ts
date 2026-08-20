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

(globalThis as { localStorage?: Storage }).localStorage = new MemoryStorage();

import { useBoxStore, migratePersistedState, migratePersisted } from "../src/store/boxStore";
import { characters as charactersData } from "../src/data/characters";
import { resolveModeVariant } from "../src/utils/skins";

const store = useBoxStore;
const s = () => store.getState();
const realId = charactersData[0].id;

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
  s().userId === "keep-me" && s().filterMode === "owned",
  "importBox 保留 userId 與篩選偏好"
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

// 未知角色 ID 過濾（KNOWN_IDS）
assert(
  migratePersistedState({
    characters: {
      [realId]: { owned: true, portray: 2 },
      "999901": { owned: true, portray: 3 },
    },
  }).characters?.[realId]?.portray === 2,
  "migrate 保留已知角色"
);
assert(
  migratePersistedState({
    characters: { "999901": { owned: true, portray: 3 } },
  }).characters?.["999901"] === undefined,
  "migrate 過濾未知角色 ID"
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

/* ---------- purgeUnreleased ---------- */

// 未持有但有 activeVariant / customVariants 的角色也應被清乾淨
const first = charactersData[0];
s().setActiveVariant(first.id, first.skins[0].variantId); // 未持有也會寫 activeVariant + custom
s().purgeUnreleased([first.id]);
assert(s().characters[first.id] === undefined, "purgeUnreleased 清除未持有角色 characters");
assert(s().activeVariant[first.id] === undefined, "purgeUnreleased 清除 activeVariant（未持有也有）");
assert(s().customVariants[first.id] === undefined, "purgeUnreleased 清除 customVariants（未持有也有）");

// 已持有角色也清
s().activateCharacter(first.id);
s().purgeUnreleased([first.id]);
assert(s().characters[first.id] === undefined, "purgeUnreleased 清除已持有角色");

// 無關角色不受影響
s().activateCharacter("B");
s().purgeUnreleased([first.id]);
assert(s().characters["B"]?.owned === true, "purgeUnreleased 不影響其他角色");

/* ---------- migrate：variant 校驗 ---------- */

const realVariant = charactersData[0].skins[0].variantId;
const okVariant = migratePersistedState({
  activeVariant: { [realId]: realVariant, X: "12345", [realId + "bad"]: "99999" },
}) as { activeVariant?: Record<string, string> };
assert(
  okVariant.activeVariant?.[realId] === realVariant,
  "migrate 保留合法 variant"
);
assert(
  okVariant.activeVariant?.["X"] === undefined,
  "migrate 過濾未知角色 activeVariant"
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
// version >=6 → 保留合法 activeVariant
const m6 = migratePersisted({ activeVariant: { [realId]: realVariant } }, 6) as {
  activeVariant?: Record<string, string>;
};
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

console.log(process.exitCode ? "\n有失敗項目" : "\n全部通過");
