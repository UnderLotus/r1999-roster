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

import { useBoxStore, migratePersistedState } from "../src/store/boxStore";

const store = useBoxStore;
const s = () => store.getState();

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

// 取消持有
s().removeCharacter("A");
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

/* ---------- migrate 驗證 ---------- */

// 正常資料
const ok = migratePersistedState({
  characters: {
    X: { owned: true, portray: 3 },
  },
});
assert(ok.characters?.["X"].portray === 3, "migrate 保留正常值");

// clamp
assert(
  migratePersistedState({ characters: { X: { owned: true, portray: 99 } } })
    .characters?.["X"].portray === 5,
  "migrate clamp portray 99→5"
);
assert(
  migratePersistedState({ characters: { X: { owned: true, portray: -3 } } })
    .characters?.["X"].portray === 0,
  "migrate clamp 負數→0"
);

// owned false 不保留（store invariant：未持有不存 characters）
assert(
  migratePersistedState({ characters: { Y: { owned: false, portray: 3 } } })
    .characters?.["Y"] === undefined,
  "migrate owned false 不保留"
);

// 字串 owned "false" 不當 true（也不保留）
assert(
  migratePersistedState({
    characters: { Z: { owned: "false" as never, portray: 3 } },
  }).characters?.["Z"] === undefined,
  "migrate 字串 owned false 不誤判"
);

// 小數/字串/Infinity portray → 0
assert(
  migratePersistedState({
    characters: { P: { owned: true, portray: 2.5 } },
  }).characters?.["P"].portray === 0,
  "migrate 小數 portray → 0"
);
assert(
  migratePersistedState({
    characters: { P: { owned: true, portray: "3" as never } },
  }).characters?.["P"].portray === 0,
  "migrate 字串 portray → 0"
);
assert(
  migratePersistedState({
    characters: { P: { owned: true, portray: Infinity } },
  }).characters?.["P"].portray === 0,
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

console.log(process.exitCode ? "\n有失敗項目" : "\n全部通過");
