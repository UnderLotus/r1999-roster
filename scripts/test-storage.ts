// Pure storage adapter tests (no boxStore import, no global localStorage needed).
import assert from "node:assert/strict";

import { createJSONStorage } from "zustand/middleware";

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

async function captureWarnings(action: () => unknown | Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await action();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

const key = "reverse1999-box-state";
const persistedState = {
  characters: { "300301": { owned: true as const, portray: 3 as const } },
  displayLang: "zh-TW" as const,
  activeVariant: { "300301": "300301" },
  customVariants: { "300301": true as const },
  userId: "storage-user",
  langChosen: true,
  showFutureSight: false,
  defaultSkinMode: "insight" as const,
};
const envelope = { state: persistedState, version: 9 };
const canonical = JSON.stringify(envelope);
const legacy = JSON.stringify(canonical);

function createComposedStorage(value?: string) {
  const raw = new FakeRawStorage();
  if (value !== undefined) raw.values.set(key, value);
  const composed = createJSONStorage<typeof persistedState>(() => createSafeStorage(raw));
  assert.ok(composed);
  return { raw, composed };
}

// Legacy double-encoded JSON hydrates and rewrites once to canonical format.
{
  const { raw, composed } = createComposedStorage(legacy);
  const hydrated = await composed.getItem(key);
  assert.deepEqual(hydrated, envelope, "legacy wire hydrates through createJSONStorage");
  assert.deepEqual(raw.writes, [{ key, value: canonical }], "legacy bytes rewrite once on first read");
}

// Canonical format hydrates without rewriting.
{
  const { raw, composed } = createComposedStorage(canonical);
  assert.deepEqual(await composed.getItem(key), envelope);
  assert.deepEqual(raw.writes, [], "canonical hydration does not rewrite storage");
}

// Writes encode once and pass bytes unchanged.
{
  const { raw, composed } = createComposedStorage();
  await composed.setItem(key, envelope);
  assert.deepEqual(raw.writes, [{ key, value: canonical }]);
}

// Corrupt values fail closed without deleting or rewriting stored bytes.
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

// Read errors fail silently without tripping write-failure warning flag.
{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnRead = true;
  assert.equal(createSafeStorage(raw).getItem(key), null, "read exception fails safely");
  assert.equal(consumeStorageError(), false, "read failures remain silent");
}

// Legacy rewrite failure still hydrates, keeps legacy bytes, logs warning, and sets error flag.
{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.values.set(key, legacy);
  raw.throwOnWrite = true;
  let hydrated: string | null = null;
  const warnings = await captureWarnings(async () => {
    hydrated = await createSafeStorage(raw).getItem(key);
  });
  assert.equal(hydrated, canonical, "legacy rewrite failure does not block hydration");
  assert.equal(raw.values.get(key), legacy, "failed rewrite preserves legacy bytes");
  assert.equal(consumeStorageError(), true, "legacy rewrite failure sets warning flag");
  assert.match(warnings[0] ?? "", /legacy persist rewrite failed/);
}

// Write and remove failures log warnings and set the storage error flag.
{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnWrite = true;
  const warnings = await captureWarnings(() =>
    createSafeStorage(raw).setItem(key, canonical)
  );
  assert.equal(consumeStorageError(), true, "canonical write failure sets warning flag");
  assert.match(warnings[0] ?? "", /persist failed/);
}

{
  consumeStorageError();
  const raw = new FakeRawStorage();
  raw.throwOnRemove = true;
  const warnings = await captureWarnings(() =>
    createSafeStorage(raw).removeItem(key)
  );
  assert.equal(consumeStorageError(), true, "remove failure sets warning flag");
  assert.match(warnings[0] ?? "", /persist remove failed/);
}

consumeStorageError();
console.log("Storage adapter checks passed.");
