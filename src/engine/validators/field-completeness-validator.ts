/**
 * Field-completeness validator — generalizes "missing field detection" beyond
 * the NSFW-only `PrivacyProfileValidator`.
 *
 * Driven by the `rules/required-fields.json` contract in the Game Pack:
 *
 * ```jsonc
 * {
 *   "npc":    { "always": [...], "nsfw": [...] },
 *   "player": { "always": [...], "nsfw": [...] }
 * }
 * ```
 *
 * Outputs a structured report the `FieldRepairPipeline` consumes. The repair
 * pipeline reuses the main-round context (step-2 flow) and injects the
 * missing-fields summary into the prompt.
 *
 * Privacy profile stays out of this file's scope — its deep 8-field contract
 * lives in `privacy-profile-validator.ts` and is invoked as a specialist step
 * after this generic validator runs.
 */
import type { StateManager } from '../core/state-manager';
import type { EnginePathConfig } from '../pipeline/types';

/** 必填字段规则 — 与 rules/required-fields.json 顶层结构一致 */
export interface RequiredFieldsConfig {
  npc?: {
    always?: string[];
    nsfw?: string[];
  };
  player?: {
    always?: string[];
    nsfw?: string[];
  };
}

/** Single entity's missing-field result */
interface EntityFieldReport {
  /** 'npc' for relationship entries, 'player' for 角色.* top-level paths */
  entityType: 'npc' | 'player';
  /** Unique display name (NPC 名称 for npcs, '玩家' for player) */
  entityName: string;
  /** Absolute state-tree path prefix for this entity (e.g. `社交.关系[名称=李明阳]` or empty for player) */
  pathPrefix: string;
  /** Missing field names — relative to the entity, or absolute paths for player entries */
  missingFields: string[];
}

/** Full report across all scanned entities */
export interface FieldRepairReport {
  entities: EntityFieldReport[];
  get total(): number;
}

const PLACEHOLDERS = new Set([
  '待生成', '待ai生成', '暂无', '无', '未知', '未定义', 'tbd', 'todo', 'placeholder', '',
]);

function isValueMissing(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return true;
    return PLACEHOLDERS.has(trimmed.toLowerCase());
  }
  if (typeof value === 'number') return Number.isNaN(value);
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/** Get a nested value using dot-path (no array-filter syntax needed here). */
function pickDeep(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split('.');
  let cursor: unknown = obj;
  for (const p of parts) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[p];
  }
  return cursor;
}

/**
 * Scan the state tree and return every entity that has at least one required
 * field missing. Empty report → nothing to repair.
 */
export function findIncompleteFields(
  stateManager: StateManager,
  paths: EnginePathConfig,
  config: RequiredFieldsConfig,
  options: { nsfwMode: boolean },
): FieldRepairReport {
  const entities: EntityFieldReport[] = [];

  // ── NPCs ──────────────────────────────────────────────────────
  const npcRules = config.npc;
  if (npcRules) {
    const npcRequired = [
      ...(npcRules.always ?? []),
      ...(options.nsfwMode ? (npcRules.nsfw ?? []) : []),
    ];

    const relationships = stateManager.get<Array<Record<string, unknown>>>(paths.relationships);
    if (Array.isArray(relationships) && npcRequired.length > 0) {
      for (const npc of relationships) {
        if (!npc || typeof npc !== 'object') continue;
        const name = String(npc[paths.npcFieldNames.name] ?? '').trim();
        if (!name) continue; // NPCs without a name get skipped — repair can't target them

        const missing: string[] = [];
        for (const field of npcRequired) {
          if (isValueMissing(npc[field])) missing.push(field);
        }
        if (missing.length > 0) {
          entities.push({
            entityType: 'npc',
            entityName: name,
            pathPrefix: `${paths.relationships}[${paths.npcFieldNames.name}=${name}]`,
            missingFields: missing,
          });
        }
      }
    }
  }

  // ── Player ────────────────────────────────────────────────────
  const playerRules = config.player;
  if (playerRules) {
    const playerRequired = [
      ...(playerRules.always ?? []),
      ...(options.nsfwMode ? (playerRules.nsfw ?? []) : []),
    ];
    if (playerRequired.length > 0) {
      const missing: string[] = [];
      for (const absPath of playerRequired) {
        const val = pickDeep(stateManager.getTree(), absPath);
        if (isValueMissing(val)) missing.push(absPath);
      }
      if (missing.length > 0) {
        entities.push({
          entityType: 'player',
          entityName: '玩家',
          pathPrefix: '',
          missingFields: missing,
        });
      }
    }
  }

  return {
    entities,
    get total() { return entities.length; },
  };
}

/**
 * Extract the required-fields config from the Game Pack's `rules.requiredFields`
 * entry. Returns an empty config when absent so callers don't special-case it.
 */
export function readRequiredFieldsConfig(rules: Record<string, unknown> | undefined): RequiredFieldsConfig {
  if (!rules) return {};
  const cfg = rules['requiredFields'];
  if (!cfg || typeof cfg !== 'object') return {};
  return cfg as RequiredFieldsConfig;
}

/**
 * Human-readable summary built from a report — used as a prompt template
 * variable (`MISSING_FIELDS_SUMMARY`). Structure is markdown-friendly so the
 * AI can parse it naturally.
 */
export function formatMissingFieldsSummary(report: FieldRepairReport): string {
  if (report.entities.length === 0) return '（无缺失字段）';

  const lines: string[] = [];
  const npcEntries = report.entities.filter((e) => e.entityType === 'npc');
  const playerEntries = report.entities.filter((e) => e.entityType === 'player');

  if (npcEntries.length > 0) {
    lines.push(`### NPC 缺失字段（共 ${npcEntries.length} 位）`);
    for (const e of npcEntries) {
      lines.push(`- **${e.entityName}** → 缺失: ${e.missingFields.map((f) => `\`${f}\``).join('、')}`);
    }
  }
  if (playerEntries.length > 0) {
    lines.push('');
    lines.push('### 玩家实体缺失字段');
    for (const e of playerEntries) {
      lines.push(`- ${e.missingFields.map((f) => `\`${f}\``).join('、')}`);
    }
  }
  return lines.join('\n');
}
