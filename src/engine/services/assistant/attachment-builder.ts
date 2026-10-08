/**
 * AttachmentBuilder — 把用户选择的状态树路径转换为完整 AttachmentPayload
 *
 * 工作内容：
 * 1. 从 stateManager 取 path 的当前值
 * 2. deep-clone（避免 Vue reactive proxy 污染发出的请求）
 * 3. 按 `nsfwMode` 决定是否剥离 NSFW 子树
 * 4. 从 game pack state-schema 裁出该 path 的子 schema 片段（含 $comment 注释）
 * 5. 生成 human-readable label（带数组项数提示）
 *
 * 注意：这是**纯无副作用**的服务，不持有状态。每个 build 调用是独立的。
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §4 + Phase 2。
 */
import type { StateManager } from '../../core/state-manager';
import type { GamePack } from '../../types';
import type {
  AttachmentSpec,
  AttachmentPayload,
  AttachmentSummary,
} from './types';
import { normalizeStatePath } from './assistant-blocklist';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';

/**
 * NSFW 路径模式 —— 与 `src/engine/memory/snapshot-sanitizer.ts` 的 NSFW_STRIP_PATHS 对齐
 *
 * 通配符 `*` 匹配数组任意下标。我们重复定义而非 import，原因：
 * - sanitizer 是 stringify-time（基于 JSON.stringify replacer），attachment 需要 deep-clone-time
 * - 两边职责清楚，独立演进
 */
const NSFW_STRIP_PATTERNS: readonly string[] = [
  `${DEFAULT_ENGINE_PATHS.relationships}.*.${DEFAULT_ENGINE_PATHS.npcFieldNames.privacyProfile}`,
  DEFAULT_ENGINE_PATHS.playerBody,
];

export interface AttachmentBuilderDeps {
  stateManager: StateManager;
  gamePack: GamePack | null;
  /**
   * Current UI locale (e.g. 'zh-CN', 'en').
   * When provided, the builder looks up `pathLabel.*` entries from
   * `gamePack.i18n[locale]` to translate path segments in display labels.
   * Optional — when absent, raw Chinese segments are used as fallback.
   */
  locale?: string;
}

export class AttachmentBuilder {
  constructor(private deps: AttachmentBuilderDeps) {}

  /**
   * 构造一份完整 attachment（含 snapshot + schema + nsfw 标志）
   *
   * @param spec 用户选择的 path + scope
   * @returns 可直接喂给 MessageBuilder 的 AttachmentPayload
   * @throws 当 path 在状态树中不存在（值 undefined）
   */
  build(spec: AttachmentSpec): AttachmentPayload {
    const path = normalizeStatePath(spec.path);
    if (!path) {
      throw new Error('[AttachmentBuilder] empty path');
    }

    const rawValue = this.deps.stateManager.get<unknown>(path);
    if (rawValue === undefined) {
      throw new Error(`[AttachmentBuilder] path "${path}" not found in state`);
    }

    // deep clone via JSON round-trip —— 同时切断 Vue reactive proxy
    // （structuredClone 在 Vue reactive 上有时抛 DOMException）
    const cloned = JSON.parse(JSON.stringify(rawValue)) as unknown;

    // NSFW 剥离（仅当 nsfwMode=false）
    const nsfwMode = this.deps.stateManager.get<unknown>('系统.nsfwMode') === true;
    let nsfwStripped = false;
    let snapshot = cloned;
    if (!nsfwMode) {
      const result = stripNsfwAtPath(cloned, path);
      snapshot = result.value;
      nsfwStripped = result.stripped;
    }

    const schemaFragment = this.extractSchemaFragment(path);
    const summary = this.buildSummary(path, spec.scope, rawValue);

    return {
      ...summary,
      snapshot,
      schemaFragment,
      nsfwStripped,
    };
  }

  /**
   * 仅生成 summary —— 用于历史回放（不需要重发完整 snapshot）
   *
   * UI 在显示历史 user message 的 attachment chips 时调用此方法。
   */
  buildSummary(
    path: string,
    scope: AttachmentSpec['scope'],
    value: unknown,
  ): AttachmentSummary {
    const normalized = normalizeStatePath(path);
    const itemCount = Array.isArray(value) ? value.length : undefined;
    return {
      path: normalized,
      label: this.buildLabel(normalized, value),
      scope,
      itemCount,
    };
  }

  // ─── 内部 ──────────────────────────────────────────────────

  /**
   * 生成 human-readable label —— 在 schema 中查 x-assistant-label
   * 缺失时 fallback 到 path 的最后一段
   *
   * 数组类型自动追加 "(N 项)"。
   */
  private buildLabel(path: string, value: unknown): string {
    const segments = path.split('.');
    const tail = segments[segments.length - 1];
    // Priority: x-assistant-label from schema > pathLabel translation > raw segment
    const pathLabelTranslation = this.getPathLabelTranslation(tail);
    const schemaLabel = this.extractAssistantLabel(path) ?? pathLabelTranslation ?? tail;
    if (Array.isArray(value)) {
      return `${schemaLabel}（${value.length} 项）`;
    }
    return schemaLabel;
  }

  /**
   * Look up a pathLabel translation from the pack's i18n data for the current locale.
   * Returns null if no locale is set, no pack i18n exists, or the key is missing.
   */
  private getPathLabelTranslation(segment: string): string | null {
    const locale = this.deps.locale;
    if (!locale) return null;
    const i18nData = this.deps.gamePack?.i18n?.[locale];
    if (!i18nData) return null;
    const label = i18nData[`pathLabel.${segment}`];
    return typeof label === 'string' ? label : null;
  }

  /**
   * 从 state-schema 裁出 path 对应的子 schema
   *
   * 不存在时返回空对象 —— validator 在另一层负责报错。
   */
  private extractSchemaFragment(path: string): Record<string, unknown> {
    const root = this.getStateSchema();
    if (!root) return {};
    return walkSchema(root, path);
  }

  /**
   * 找 path 的 x-assistant-label 元数据
   *
   * Phase 4 会给 state-schema.json 加这个字段；MVP 此处优雅降级返回 null。
   */
  private extractAssistantLabel(path: string): string | null {
    const root = this.getStateSchema();
    if (!root) return null;
    const sub = walkSchema(root, path);
    const label = sub['x-assistant-label'];
    return typeof label === 'string' ? label : null;
  }

  private getStateSchema(): Record<string, unknown> | null {
    // GamePack.stateSchema 是直接顶级字段（camelCase 单数），不是嵌套在 schemas 里
    // 2026-04-14 fix：早期实现误读为 `pack.schemas['state-schema']`，导致 schema 永远取不到 ⇒
    // 所有路径都被 validator 判"不存在" + attachment 的 schemaFragment 永远为空
    const pack = this.deps.gamePack;
    if (!pack) return null;
    return pack.stateSchema ?? null;
  }

  /**
   * Story 3: suggest default attachments for worldBuilder mode.
   * Caller provides engine paths to avoid hardcoding game-specific paths in engine code.
   */
  suggestWorldBuilderAttachments(paths: { relationships: string; locations: string; worldDescription: string }): AttachmentSpec[] {
    return [
      { path: paths.relationships, scope: 'context' },
      { path: paths.locations, scope: 'context' },
      { path: paths.worldDescription, scope: 'context' },
    ];
  }
}

// ─── 工具：schema walk ────────────────────────────────────

/**
 * 沿 path 在 JSON Schema 树中走到叶子 schema
 *
 * 处理：
 * - object 节点的 `properties.<name>`
 * - array 节点的 `items`（数组元素 schema）
 * - additionalProperties（如 Record<string, X> 的 X schema）
 *
 * 找不到时返回空对象。
 */
function walkSchema(root: Record<string, unknown>, path: string): Record<string, unknown> {
  if (!path) return root;
  const segments = path.split('.');
  let current: Record<string, unknown> = root;

  for (const seg of segments) {
    // 数组下标段（"0", "1", ...）：进 items
    if (/^\d+$/.test(seg)) {
      const items = current['items'];
      if (items && typeof items === 'object') {
        current = items as Record<string, unknown>;
        continue;
      }
      return {};
    }

    // 对象属性：进 properties.<seg>
    const props = current['properties'];
    if (props && typeof props === 'object') {
      const next = (props as Record<string, unknown>)[seg];
      if (next && typeof next === 'object') {
        current = next as Record<string, unknown>;
        continue;
      }
    }

    // additionalProperties（Record 类型）
    const addProps = current['additionalProperties'];
    if (addProps && typeof addProps === 'object') {
      current = addProps as Record<string, unknown>;
      continue;
    }

    return {};
  }
  return current;
}

// ─── 工具：NSFW 剥离 ──────────────────────────────────────

interface StripResult {
  value: unknown;
  stripped: boolean;
}

/**
 * 在已 deep-cloned 的 attachment value 上应用 NSFW 剥离
 *
 * @param cloned 已 deep-cloned 的子树（不会被外部观察到 mutation）
 * @param attachPath attach 的根路径（如 "社交.关系" 或 "角色.身体"）
 * @returns { value: 剥离后的子树, stripped: 是否真的剥离过 }
 *
 * 算法：
 * 1. 把每个 NSFW_STRIP_PATTERN 转成"相对 attachPath"的子路径
 *    例：attachPath="社交.关系", pattern="社交.关系.*.私密信息" → 子路径 "*.私密信息"
 * 2. 对相对路径递归剥离（处理 `*` 通配符）
 * 3. attachPath 完全等于 pattern 时（如 attachPath="角色.身体"）直接返回 null
 */
function stripNsfwAtPath(cloned: unknown, attachPath: string): StripResult {
  let stripped = false;
  let value = cloned;

  for (const pattern of NSFW_STRIP_PATTERNS) {
    // 情况 A：attachPath 完全等于 pattern（且 pattern 无 *）→ 整子树是 NSFW
    if (pattern === attachPath) {
      return { value: null, stripped: true };
    }
    // 情况 B：attachPath 是 pattern 的祖先，需要在子树中递归剥离
    if (pattern.startsWith(attachPath + '.')) {
      const relativePath = pattern.slice(attachPath.length + 1);
      const before = JSON.stringify(value);
      value = stripPathInValue(value, relativePath.split('.'));
      const after = JSON.stringify(value);
      if (before !== after) stripped = true;
    }
    // 情况 C：attachPath 是 pattern 的后代或不相关 —— 这两种都不需要剥离
    // （后代不可能有更深的 NSFW；不相关无需操作）
  }

  return { value, stripped };
}

/** 在 value 上按 segments 路径删除目标字段（处理 `*` 通配符） */
function stripPathInValue(value: unknown, segments: string[]): unknown {
  if (segments.length === 0 || value == null || typeof value !== 'object') {
    return value;
  }
  const [head, ...rest] = segments;

  if (head === '*') {
    // 通配符：value 应该是数组或对象 record
    if (Array.isArray(value)) {
      return value.map((item) => stripPathInValue(item, rest));
    }
    if (typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = stripPathInValue(v, rest);
      }
      return result;
    }
    return value;
  }

  // 普通字段
  if (rest.length === 0) {
    // 最后一段：删除该字段
    if (Array.isArray(value)) {
      return value; // 数组里不直接删字段名
    }
    const obj = { ...(value as Record<string, unknown>) };
    delete obj[head];
    return obj;
  }

  // 中间段：递归
  if (Array.isArray(value)) {
    // 中间出现数字索引或具体字段时（如 "0.子字段"），按需处理
    if (/^\d+$/.test(head)) {
      const idx = Number(head);
      if (idx >= value.length) return value;
      const next = [...value];
      next[idx] = stripPathInValue(next[idx], rest);
      return next;
    }
    return value;
  }

  const obj = value as Record<string, unknown>;
  if (!(head in obj)) return value;
  return {
    ...obj,
    [head]: stripPathInValue(obj[head], rest),
  };
}
