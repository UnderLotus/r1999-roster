import * as ts from "typescript";

import type { CharacterSkin } from "./types";

export const UTTU_PROFILES_URL = "https://uttu.merui.net/profiles/";
export const UTTU_GARMENTS_URL = "https://uttu.merui.net/garments/";
export const UTTU_ASSET_BASE_URL = "https://assets.merui.net/headicon_middle/";

export const UTTU_NAME_LANGS = [
  "zh-CN",
  "zh-TW",
  "en-US",
  "ja-JP",
  "ko-KR",
] as const;

export type UttuNameLang = (typeof UTTU_NAME_LANGS)[number];

export interface UttuProfile {
  readonly baseId: number;
  readonly name: string;
  readonly nameEng: string;
  readonly names: Partial<Record<UttuNameLang, string>>;
  readonly rarity: number;
}

export interface UttuGarment {
  readonly baseId: number;
  readonly variantId: string;
  readonly type: CharacterSkin["type"];
  readonly skinName: string | null;
  readonly skinNameEng: string | null;
}

export interface UttuCatalog {
  readonly profiles: readonly UttuProfile[];
  readonly garments: readonly UttuGarment[];
  readonly diagnostics: readonly string[];
  /** Profiles with at least one garment row that could not be normalized. */
  readonly incompleteBaseIds: ReadonlySet<number>;
}

export class UttuParseError extends Error {
  readonly kind = "parse" as const;

  constructor(message: string) {
    super(message);
    this.name = "UttuParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Trim a literal name and treat empty/N/A placeholders as absent. */
export function normalizeUttuName(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.toUpperCase() === "N/A") return null;
  return name;
}

function localeNames(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const names: Record<string, string> = {};
  for (const [key, rawName] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const name = normalizeUttuName(rawName);
    if (name) names[key] = name;
  }
  return names;
}

type LiteralResult = unknown | typeof UNSUPPORTED;
const UNSUPPORTED = Symbol("unsupported-uttu-literal");

function propertyName(node: ts.PropertyName, source: ts.SourceFile): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  if (ts.isComputedPropertyName(node)) {
    const name = literal(node.expression, source);
    return typeof name === "string" || typeof name === "number" ? String(name) : null;
  }
  return null;
}

/**
 * Read only literal JavaScript values. There is intentionally no eval/vm:
 * downloaded site text is data and any non-literal field is rejected.
 */
function literal(node: ts.Expression, source: ts.SourceFile): LiteralResult {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isIdentifier(node) && node.text === "undefined") return undefined;
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = literal(node.operand, source);
    if (operand === UNSUPPORTED) return UNSUPPORTED;
    if (node.operator === ts.SyntaxKind.MinusToken && typeof operand === "number") {
      return -operand;
    }
    if (node.operator === ts.SyntaxKind.ExclamationToken) return !operand;
    if (node.operator === ts.SyntaxKind.PlusToken && typeof operand === "number") {
      return operand;
    }
    return UNSUPPORTED;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) return UNSUPPORTED;
      const value = literal(element, source);
      if (value === UNSUPPORTED) return UNSUPPORTED;
      values.push(value);
    }
    return values;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) return UNSUPPORTED;
      const name = propertyName(property.name, source);
      if (!name || name === "__proto__" || name === "constructor" || name === "prototype") {
        return UNSUPPORTED;
      }
      const propertyValue = literal(property.initializer, source);
      if (propertyValue === UNSUPPORTED) return UNSUPPORTED;
      value[name] = propertyValue;
    }
    return value;
  }
  return UNSUPPORTED;
}

function extractLiteralArrays(html: string): unknown[][] {
  const arrays: unknown[][] = [];
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const script = match[2];
    if (!script.trim()) continue;

    const source = ts.createSourceFile(
      "uttu-inline.js",
      script,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const visit = (node: ts.Node): void => {
      if (ts.isArrayLiteralExpression(node)) {
        const value = literal(node, source);
        if (Array.isArray(value)) arrays.push(value);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return arrays;
}

function isProfileRow(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.ID) &&
    (value.ID as number) > 0 &&
    (typeof value.Name === "string" || typeof value.Name === "number") &&
    isRecord(value.LocaleName)
  );
}

function isGarmentRow(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    isRecord(value.profile) &&
    Number.isSafeInteger(value.profile.ID) &&
    isRecord(value.garment) &&
    Number.isSafeInteger(value.garment.id) &&
    typeof value.garment.category === "string" &&
    isRecord(value.garment.name)
  );
}

function chooseArray(
  arrays: readonly unknown[][],
  predicate: (row: unknown) => boolean,
  label: string
): unknown[] {
  const candidates = arrays.filter(
    (array) => array.length > 0 && array.every((row) => predicate(row))
  );
  if (candidates.length === 0) {
    throw new UttuParseError(`No recognizable UTTU ${label} literal array found`);
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function normalizeProfiles(rows: readonly unknown[]): {
  profiles: UttuProfile[];
  diagnostics: string[];
} {
  const profiles: UttuProfile[] = [];
  const diagnostics: string[] = [];
  const seen = new Set<number>();

  for (const raw of rows) {
    if (!isProfileRow(raw)) continue;
    const baseId = raw.ID as number;
    if (seen.has(baseId)) {
      throw new UttuParseError(`Duplicate UTTU profile ID: ${baseId}`);
    }
    seen.add(baseId);

    if (
      !Number.isInteger(raw.Rarity) ||
      (raw.Rarity as number) < 2 ||
      (raw.Rarity as number) > 6
    ) {
      diagnostics.push(`UTTU profile ${baseId} has invalid rarity; skipped`);
      continue;
    }
    const name = normalizeUttuName(raw.Name);
    if (!name) {
      diagnostics.push(`UTTU profile ${baseId} has no usable name; skipped`);
      continue;
    }

    const locales = localeNames(raw.LocaleName);
    const zh = normalizeUttuName(locales.zh);
    const en = normalizeUttuName(locales.en) ?? name;
    if (!zh) {
      diagnostics.push(`UTTU profile ${baseId} has no usable zh name; skipped`);
      continue;
    }

    const names: Partial<Record<UttuNameLang, string>> = {
      "zh-CN": zh,
      "en-US": en,
    };
    const localeMap: Array<[string, UttuNameLang]> = [
      ["tw", "zh-TW"],
      ["jp", "ja-JP"],
      ["kr", "ko-KR"],
    ];
    for (const [sourceKey, lang] of localeMap) {
      const localizedName = normalizeUttuName(locales[sourceKey]);
      if (localizedName) names[lang] = localizedName;
    }

    profiles.push({
      baseId,
      name: zh,
      nameEng: en,
      names,
      rarity: raw.Rarity as number,
    });
  }

  profiles.sort((a, b) => a.baseId - b.baseId);
  return { profiles, diagnostics };
}

const CATEGORY_TYPES: Readonly<Record<string, CharacterSkin["type"]>> = {
  default: "default",
  insight: "insight",
  advanced: "skin",
  basic: "skin",
  unique: "skin",
  free: "skin",
  roar_jukebox: "skin",
};

function normalizeGarments(
  rows: readonly unknown[],
  profiles: readonly UttuProfile[]
): {
  garments: UttuGarment[];
  diagnostics: string[];
  incompleteBaseIds: Set<number>;
  owners: Map<string, Set<number>>;
} {
  const profileIds = new Set(profiles.map((profile) => profile.baseId));
  const diagnostics: string[] = [];
  const incompleteBaseIds = new Set<number>();
  const owners = new Map<string, Set<number>>();
  const parsed: Array<{ baseId: number; variantId: string; row: Record<string, unknown> }> = [];

  for (const raw of rows) {
    if (!isGarmentRow(raw)) continue;
    const profile = raw.profile as Record<string, unknown>;
    const garment = raw.garment as Record<string, unknown>;
    const baseId = profile.ID as number;
    const variantId = String(garment.id);
    if (!profileIds.has(baseId)) {
      diagnostics.push(`UTTU garment ${variantId} references unknown profile ${baseId}; skipped`);
      continue;
    }
    if (!CATEGORY_TYPES[garment.category as string]) {
      diagnostics.push(
        `UTTU garment ${variantId} has unknown category ${String(garment.category)}; skipped`
      );
      incompleteBaseIds.add(baseId);
      continue;
    }
    const ownerSet = owners.get(variantId) ?? new Set<number>();
    ownerSet.add(baseId);
    owners.set(variantId, ownerSet);
    parsed.push({ baseId, variantId, row: raw });
  }

  for (const [variantId, ownerIds] of owners) {
    if (ownerIds.size > 1) {
      diagnostics.push(
        `UTTU garment ${variantId} has conflicting owners: ${[...ownerIds].sort().join(", ")}; rejected`
      );
      for (const ownerId of ownerIds) incompleteBaseIds.add(ownerId);
    }
  }

  const garments: UttuGarment[] = [];
  for (const { baseId, variantId, row } of parsed) {
    if ((owners.get(variantId)?.size ?? 0) !== 1) continue;
    const garment = row.garment as Record<string, unknown>;
    const type = CATEGORY_TYPES[garment.category as string];
    const names = localeNames(garment.name);
    const zh = normalizeUttuName(names.zh);
    const en = normalizeUttuName(names.en);

    if (type !== "default" && !zh && !en) {
      diagnostics.push(`UTTU garment ${variantId} has no usable skin name; skipped`);
      incompleteBaseIds.add(baseId);
      continue;
    }

    garments.push({
      baseId,
      variantId,
      type,
      skinName: type === "default" ? null : zh,
      skinNameEng: type === "default" ? null : en,
    });
  }

  garments.sort((a, b) =>
    a.baseId === b.baseId
      ? a.variantId.localeCompare(b.variantId)
      : a.baseId - b.baseId
  );
  return { garments, diagnostics, incompleteBaseIds, owners };
}

/**
 * Parse the public Astro pages' inline literal arrays. Arrays are recognized by
 * their record shape, not by script order or minified variable names.
 */
export function parseUttuCatalog(profilesHtml: string, garmentsHtml: string): UttuCatalog {
  const profileArrays = extractLiteralArrays(profilesHtml);
  const garmentArrays = extractLiteralArrays(garmentsHtml);
  const profileRows = chooseArray(profileArrays, isProfileRow, "profile");
  const garmentRows = chooseArray(garmentArrays, isGarmentRow, "garment");
  const { profiles, diagnostics: profileDiagnostics } = normalizeProfiles(profileRows);
  if (profiles.length === 0) {
    throw new UttuParseError("UTTU profiles extracted no valid records");
  }
  const normalizedGarments = normalizeGarments(garmentRows, profiles);
  if (normalizedGarments.garments.length === 0) {
    throw new UttuParseError("UTTU garments extracted no valid records");
  }

  return {
    profiles,
    garments: normalizedGarments.garments,
    diagnostics: [...profileDiagnostics, ...normalizedGarments.diagnostics],
    incompleteBaseIds: normalizedGarments.incompleteBaseIds,
  };
}
