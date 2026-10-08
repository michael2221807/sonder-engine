// App doc: docs/user-guide/pages/game-save.md §2.5.1
/**
 * Protagonist template logic — Story 5 (P4).
 *
 * Pure, pack-agnostic helpers for the fixed / template / blank protagonist modes
 * (handover §4A). Used by the import side (game-card-import-service, CardImportFlow). Returns error/warning CODES (UI resolves i18n) — the
 * engine emits no display strings.
 *
 * Character-data placement (implementation decision, recorded in the plan):
 * the (trimmed) 角色 subtree travels inside card.stateTree as the SINGLE source for
 * fixed/template; blank mode drops 角色 from stateTree (card-stripper). protagonist.data
 * is therefore unused by Story 5 export (kept optional in the type for future reuse).
 */
import type { ProtagonistMode } from './game-card-bundle.types';
import type { ProtagonistPolicy } from './card-export-paths';
import { getByPath } from './card-stripper';

export interface EditableFieldsResult {
  /** Safe — exposed for player editing as-is. */
  allowed: string[];
  /** Gray — exposed but the import UI MUST show a derivation warning (may trigger attribute recompute). */
  downgraded: string[];
  /** Rejected — never editable (derived/gameplay or unknown path); silently dropped from editableFields. */
  rejected: string[];
}

/** True if `path` equals a prefix or sits under it ("属性" matches "属性" and "属性.体质"). */
function underAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path === p || path.startsWith(p + '.'));
}

/** Normalize an absolute or relative editable path to be relative to the character root. */
function toRelative(path: string, characterRoot: string): string {
  return path.startsWith(characterRoot + '.') ? path.slice(characterRoot.length + 1) : path;
}

/**
 * Partition candidate editable fields (template mode) into allowed / gray / rejected.
 * BLACKLIST + any pack-declared derived-field targets are HARD-rejected (handover §4A):
 * derived attributes, variable attributes, status effects, image archive — editing them
 * would be overwritten on import (dead control) or leak gameplay state.
 */
export function validateEditableFields(
  candidate: readonly string[],
  policy: ProtagonistPolicy,
  derivedTargets: readonly string[] = [],
): EditableFieldsResult {
  const allowed: string[] = [];
  const downgraded: string[] = [];
  const rejected: string[] = [];
  const derivedRel = derivedTargets.map((t) => toRelative(t, policy.characterRoot));

  for (const raw of candidate) {
    const rel = toRelative(raw, policy.characterRoot);
    if (underAnyPrefix(rel, policy.editableBlacklist) || underAnyPrefix(rel, derivedRel)) {
      rejected.push(raw);
    } else if (underAnyPrefix(rel, policy.editableGray)) {
      downgraded.push(raw);
    } else if (underAnyPrefix(rel, policy.editableWhitelist)) {
      allowed.push(raw);
    } else {
      rejected.push(raw); // unknown path → conservative reject
    }
  }
  return { allowed, downgraded, rejected };
}

export interface ProtagonistValidation {
  /** Blocking issues (export must not proceed). Codes resolved to i18n in the UI. */
  errors: string[];
  /** Non-blocking advisories. */
  warnings: string[];
}

/**
 * Validate the protagonist choice against the state tree before export (handover §4A pitfalls).
 * - fixed: 姓名 must be non-empty (else imported NPC dialogue shows blank placeholders).
 * - blank: opening.firstRoundSetup should be generic (the protagonist does not exist yet at author time).
 */
export function validateProtagonistForExport(
  mode: ProtagonistMode,
  tree: Record<string, unknown>,
  policy: ProtagonistPolicy,
  opts?: { firstRoundSetup?: string },
): ProtagonistValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (mode === 'fixed') {
    const name = getByPath(tree, `${policy.characterRoot}.${policy.playerNameRelPath}`);
    if (typeof name !== 'string' || name.trim() === '') {
      errors.push('protagonist.fixed.emptyName');
    }
  }

  if (mode === 'blank' && typeof opts?.firstRoundSetup === 'string' && opts.firstRoundSetup.trim() !== '') {
    warnings.push('protagonist.blank.setupShouldBeGeneric');
  }

  return { errors, warnings };
}
