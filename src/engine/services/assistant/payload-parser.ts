/**
 * PayloadParser — 从 AI 流式响应中提取注入 payload
 *
 * AI 在 Mode B 被指示输出格式：
 *   <自然语言文本回复...>
 *
 *   ```json
 *   { "summary": "...", "patches": [...] }
 *   ```
 *
 * 解析流程（复用 preset-ai-generator + json-extract 套路）：
 * 1. 剥离 <thinking> / <think> 标签（避免 CoT 内的半成品 JSON 被选中）
 * 2. 剥离 markdown 围栏
 * 3. 用平衡括号扫描找所有顶层 JSON 块
 * 4. 候选块按"含 patches 字段 + summary 字段"得分排序
 * 5. 同分取**最末**出现的（CoT 通常在前 → 最终答案在后）
 * 6. 校验 shape：必须是 object 且 patches 是数组
 *
 * 找不到时返回 null —— 调用方决定如何处理（Mode A 完全合法，Mode B 则提示用户）。
 *
 * 对应 docs/status/plan-assistant-utility-2026-04-14.md §5.2.2 + Phase 2。
 */
import { scanJsonObjectBlocks } from '../../ai/json-extract';
import type { AssistantPayload, AssistantPatch, KnowledgeFact } from './types';

/**
 * 解析 AI 响应 → AssistantPayload | null
 *
 * @param raw AI 完整响应文本（流式累积后）
 * @returns 解析成功时的 payload；找不到合法 payload 时 null
 */
export function parseAssistantPayload(raw: string): AssistantPayload | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;

  type Candidate = { obj: AssistantPayload; score: number; index: number };
  const candidates: Candidate[] = [];

  scanJsonObjectBlocks(raw, (obj, idx) => {
    const score = scoreCandidate(obj);
    if (score === 0) return;
    const payload = sanitizePayload(obj);
    if (!payload) return;
    candidates.push({ obj: payload, score, index: idx });
  });

  if (candidates.length === 0) return null;

  // 同分取最末（最终答案约定在后）
  candidates.sort((a, b) => b.score - a.score || b.index - a.index);
  return candidates[0].obj;
}

/** 候选 JSON 块得分 —— 用于多块选择 */
function scoreCandidate(obj: Record<string, unknown>): number {
  let score = 0;
  if ('patches' in obj && Array.isArray(obj['patches'])) score += 100;
  if ('summary' in obj && typeof obj['summary'] === 'string') score += 10;
  return score;
}

/**
 * 从原始 JSON 净化为合法 AssistantPayload
 *
 * - 容忍 summary 缺失（用空字符串）
 * - patches 必须是数组，每个元素必须有 target/op
 * - 单条 patch 字段净化：
 *   - target → string
 *   - op → 六个枚举之一（其他值跳过该 patch）
 *   - value/match/rationale 透传
 * - knowledge_facts（optional）：worldBuilder 模式下 AI 输出的关系数据
 */
function sanitizePayload(raw: Record<string, unknown>): AssistantPayload | null {
  const patchesRaw = raw['patches'];
  if (!Array.isArray(patchesRaw)) return null;

  const patches: AssistantPatch[] = [];
  for (const item of patchesRaw) {
    if (!item || typeof item !== 'object') continue;
    const sanitized = sanitizePatch(item as Record<string, unknown>);
    if (sanitized) patches.push(sanitized);
  }

  const knowledgeFacts = sanitizeKnowledgeFacts(raw['knowledge_facts']);

  const result: AssistantPayload = {
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : '',
    patches,
  };
  if (knowledgeFacts.length > 0) {
    result.knowledgeFacts = knowledgeFacts;
  }
  return result;
}

function sanitizeKnowledgeFacts(raw: unknown): KnowledgeFact[] {
  if (!Array.isArray(raw)) return [];
  const facts: KnowledgeFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const sourceEntity = typeof r['sourceEntity'] === 'string' ? r['sourceEntity'] : '';
    const targetEntity = typeof r['targetEntity'] === 'string' ? r['targetEntity'] : '';
    const fact = typeof r['fact'] === 'string' ? r['fact'] : '';
    if (!sourceEntity || !targetEntity || !fact) continue;
    const confidence = typeof r['confidence'] === 'number' ? r['confidence'] : 1.0;
    facts.push({ sourceEntity, targetEntity, fact, confidence });
  }
  return facts;
}

const VALID_OPS = new Set(['set-field', 'append-item', 'insert-item', 'replace-item', 'remove-item', 'replace-array']);

function sanitizePatch(raw: Record<string, unknown>): AssistantPatch | null {
  const target = typeof raw['target'] === 'string' ? raw['target'] : '';
  const op = typeof raw['op'] === 'string' ? raw['op'] : '';
  if (!target || !VALID_OPS.has(op)) return null;

  const result: AssistantPatch = {
    target,
    op: op as AssistantPatch['op'],
  };
  if ('value' in raw) result.value = raw['value'];
  if (raw['match'] && typeof raw['match'] === 'object') {
    const m = raw['match'] as Record<string, unknown>;
    if (typeof m['by'] === 'string' && 'value' in m) {
      result.match = { by: m['by'], value: m['value'] };
    }
  }
  // 2026-04-14 新增：解析 insert-item 的 position 字段
  if (raw['position'] && typeof raw['position'] === 'object') {
    const parsed = sanitizePosition(raw['position'] as Record<string, unknown>);
    if (parsed) result.position = parsed;
  }
  if (typeof raw['rationale'] === 'string') {
    result.rationale = raw['rationale'];
  }
  return result;
}

/**
 * 解析 insert-item 的 position 字段 —— 容忍 AI 多种写法，严格校验形态
 *
 * 合法形态：
 *   { at: 'start' | 'end' }
 *   { before: { by: string, value: ... } }
 *   { after:  { by: string, value: ... } }
 */
function sanitizePosition(raw: Record<string, unknown>): AssistantPatch['position'] | null {
  if (raw['at'] === 'start' || raw['at'] === 'end') {
    return { at: raw['at'] };
  }
  const before = raw['before'];
  if (before && typeof before === 'object') {
    const m = before as Record<string, unknown>;
    if (typeof m['by'] === 'string' && 'value' in m) {
      return { before: { by: m['by'], value: m['value'] } };
    }
  }
  const after = raw['after'];
  if (after && typeof after === 'object') {
    const m = after as Record<string, unknown>;
    if (typeof m['by'] === 'string' && 'value' in m) {
      return { after: { by: m['by'], value: m['value'] } };
    }
  }
  return null;
}
