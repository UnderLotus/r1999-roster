import assert from "node:assert/strict";

import { createJSONStorage } from "zustand/middleware";

import { characters } from "../src/data/characters";
import {
  migratePersisted,
  partializeBoxStore,
  useBoxStore,
} from "../src/store/boxStore";
import {
  consumeStorageError,
  createSafeStorage,
} from "../src/utils/storage";

class FakeRawStorage {
  values = new Map<string, string>();
  writes: Array<{ key: string; value: string }> = [];
  removals: string[] = [];
  throwOnRead = false;
  throwOnWrite = false;
  throwOnRemove = false;

  getItem(key: string): string | null {
    if (this.throwOnRead) throw new Error("read failed");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new Error("write failed");
    this.writes.push({ key, value });
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.throwOnRemove) throw new Error("remove failed");
    this.removals.push(key);
    this.values.delete(key);
  }
}

const key = "reverse1999-box-state";
const character = characters.find((entry) => entry.isReleased !== false);
assert.ok(character, "fixture has a released character");
const persistedState = {
  characters: { [character.id]: { owned: true as const, portray: 3 as const } },
  displayLang: "zh-TW" as const,
  activeVariant: { [character.id]: character.defaultVariant },
  customVariants: { [character.id]: true as const },
  userId: "storage-user",
  langChosen: true,
  showFutureSight: false,
  defaultSkinMode: "insight" as const,
};
const envelope = { state: persistedState, version: 9 };
const canonical = JSON.stringify(envelope);
const legacy = JSON.stringify(canonical);

{
  const raw = new FakeRawStorage();
  raw.values.set(key, legacy);
  const composed = createJSONStorage<typeof persistedState>(() =>
    createSafeStorage(raw)
  );
  assert.ok(composed);
  const hydrated = await composed.getItem(key);
  assert.deepEqual(hydrated, envelope, "legacy wire hydrates through createJSONStorage");
  assert.deepEqual(
    migratePersisted(hydrated?.state, hydrated?.version),
    migratePersisted(envelope.state, envelope.version),
    "legacy wire hydrates the same Box/preferences as canonical input"
  );
  assert.deepEqual(raw.writes, [{ key, value: canonical }]);
  assert.equal(raw.values.get(key), canonical, "legacy bytes rewrite canonically on first read");
}

{
  const raw = new FakeRawStorage();
  raw.values.set(key, canonical);
  const composed = createJSONStorage<typeof persistedState>(() =>
    createSafeStorage(raw)
  );
  assert.ok(composed);
  assert.deepEqual(await composed.getItem(key), envelope);
  assert.deepEqual(raw.writes, [], "canonical hydration does not rewrite storage");
}

{
  const raw = new FakeRawStorage();
  const composed = createJSONStorage<typeof persistedState>(() =>
    createSafeStorage(raw)
  );
  assert.ok(composed);
  await composed.setItem(key, envelope);
  assert.equal(raw.values.get(key), canonical);
  assert.deepEqual(
    raw.writes,
    [{ key, value: canonical }],
    "createJSONStorage encodes once and raw adapter passes bytes unchanged"
  );
}

const corruptValues = [
  ["corrupt outer JSON", "not-json"],
  ["corrupt legacy inner JSON", JSON.stringify("not-inner-json")],
  ["unexpected outer primitive", "1"],
  ["unexpected legacy-inner primitive", JSON.stringify(JSON.stringify(1))],
] as const;
for (const [label, corrupt] of corruptValues) {
  const raw = new FakeRawStorage();
  raw.values.set(key, corrupt);
  assert.equal(createSafeStorage(raw).getItem(key), null, `${label} fails closed`);
  assert.equal(raw.values.get(key), corrupt, `${label} is not deleted or rewritten`);
  assert.deepEqual(raw.writes, []);
  assert.deepEqual(raw.removals, []);
}

{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnRead = true;
  assert.equal(createSafeStorage(raw).getItem(key), null, "read exception fails safely");
  assert.equal(consumeStorageError(), false, "read failures remain silent");
}

{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.values.set(key, legacy);
  raw.throwOnWrite = true;
  assert.equal(
    await createSafeStorage(raw).getItem(key),
    canonical,
    "legacy rewrite failure does not block hydration"
  );
  assert.equal(raw.values.get(key), legacy, "failed rewrite preserves legacy bytes");
  assert.equal(consumeStorageError(), true, "legacy rewrite failure sets warning flag");
}

{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnWrite = true;
  await createSafeStorage(raw).setItem(key, canonical);
  assert.equal(consumeStorageError(), true, "canonical write failure sets warning flag");
}

{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnRemove = true;
  await createSafeStorage(raw).removeItem(key);
  assert.equal(consumeStorageError(), true, "remove failure sets warning flag");
}

{
  const projected = partializeBoxStore({
    ...useBoxStore.getState(),
    ...persistedState,
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
  console.log("ok: partialize persists only the exact Box/preferences allowlist");
}

consumeStorageError();
console.log("storage adapter checks passed");
