// Design: docs/design/civitai-lora-shelf-design.md
import type {
  CivitaiLoraScope,
  CivitaiLoraShelfItem,
  CivitaiLoraSnapshot,
  ImageSubjectType,
} from './types';

// ── Warning types ──

export type CivitaiLoraWarningType =
  | 'too_many_active'
  | 'strong_effect'
  | 'mature_mismatch'
  | 'air_conflict'
  | 'lora_trigger_syntax';

export interface CivitaiLoraWarning {
  type: CivitaiLoraWarningType;
  message: string;
  loraId?: string;
}

// ── AIR validation ──

const AIR_PREFIX = 'urn:air:';
const CIVITAI_MARKER = ':civitai:';

export function validateLoraAir(air: string): { valid: boolean; error?: string } {
  const trimmed = air.trim();
  if (!trimmed) return { valid: false, error: 'AIR 不能为空' };
  if (!trimmed.startsWith(AIR_PREFIX)) return { valid: false, error: `AIR 必须以 ${AIR_PREFIX} 开头` };
  if (!trimmed.includes(CIVITAI_MARKER)) return { valid: false, error: 'AIR 必须包含 :civitai: 标识' };
  if (!trimmed.includes(':lora:') && !trimmed.includes(':locon:') && !trimmed.includes(':lycoris:')) {
    return { valid: false, error: 'AIR 类型不是 LoRA — 请检查是否误用了 checkpoint AIR' };
  }
  if (!/:(\d+)@(\d+)$/.test(trimmed)) {
    return { valid: false, error: 'AIR 缺少 modelId@versionId（格式: civitai:数字@数字）' };
  }
  return { valid: true };
}

// ── Scope resolution ──

export function resolveLoraScope(
  subjectType: ImageSubjectType,
  targetCharacter?: string,
): CivitaiLoraScope {
  if (subjectType === 'scene') return 'scene';
  if (subjectType === 'secret_part') return 'secret_part';
  return targetCharacter === '__player__' ? 'player' : 'character';
}

// ── Active LoRA collection ──

export function collectActiveLorasForScope(
  shelf: CivitaiLoraShelfItem[],
  scope: CivitaiLoraScope,
): CivitaiLoraShelfItem[] {
  return shelf.filter(
    (item) => item.enabled && Array.isArray(item.scopes) && item.scopes.includes(scope),
  );
}

// ── Trigger injection ──

const LORA_SYNTAX_RE = /<lora:/i;

function tokenizePrompt(prompt: string): Set<string> {
  return new Set(
    prompt.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
}

// Thresholds shared by the generation-time warnings and the preflight warnings
// (the message wording stays with each caller).
const MAX_ACTIVE_LORAS = 5;
const STRONG_STRENGTH = 1.5;

/**
 * Walk the active LoRAs' auto-inject triggers against `seen` (mutated: every
 * newly injected sub-token is added). Shared by the preview
 * (`buildTriggerInjection`) and the generation path (`prepareCivitaiLora`).
 * `perLora` has an entry for every LoRA, `syntaxHits` lists the `<lora:` triggers
 * that were skipped, in encounter order.
 */
function collectTriggerInjections(
  loras: CivitaiLoraShelfItem[],
  seen: Set<string>,
): {
  perLora: Map<string, string[]>;
  all: string[];
  syntaxHits: Array<{ lora: CivitaiLoraShelfItem; text: string }>;
} {
  const perLora = new Map<string, string[]>();
  const all: string[] = [];
  const syntaxHits: Array<{ lora: CivitaiLoraShelfItem; text: string }> = [];

  for (const lora of loras) {
    const injected: string[] = [];
    if (!lora.autoInjectTriggers || !Array.isArray(lora.triggers)) {
      perLora.set(lora.id, []);
      continue;
    }
    for (const trigger of lora.triggers) {
      if (!trigger.enabled) continue;
      const text = trigger.text?.trim();
      if (!text) continue;
      if (LORA_SYNTAX_RE.test(text)) {
        syntaxHits.push({ lora, text });
        continue;
      }

      // Split by comma to handle multi-phrase triggers like "open mouth, tongue out"
      const subTokens = text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
      const allSeen = subTokens.every((st) => seen.has(st));
      if (!allSeen) {
        for (const st of subTokens) seen.add(st);
        all.push(text);
        injected.push(text);
      }
    }
    perLora.set(lora.id, injected);
  }

  return { perLora, all, syntaxHits };
}

export function buildTriggerInjection(
  activeLorasWithTriggers: CivitaiLoraShelfItem[],
  existingPrompt: string,
): string[] {
  return collectTriggerInjections(activeLorasWithTriggers, tokenizePrompt(existingPrompt)).all;
}

// ── Additional networks merge ──

export function mergeAdditionalNetworks(
  activeLorasArr: CivitaiLoraShelfItem[],
  rawJsonString: string | undefined,
): {
  merged: Record<string, unknown>;
  mergedJson: string;
  conflicts: string[];
} {
  let rawNetworks: Record<string, unknown> = {};
  const trimmed = rawJsonString?.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rawNetworks = parsed as Record<string, unknown>;
      }
    } catch (e) {
      throw new Error(`附加网络 JSON 格式错误: ${(e as Error).message}`);
    }
  }

  const conflicts: string[] = [];
  const merged = { ...rawNetworks };

  for (const lora of activeLorasArr) {
    const air = lora.air.trim();
    if (!air) continue;
    if (air in rawNetworks) conflicts.push(air);
    merged[air] = { strength: lora.strength };
  }

  return {
    merged,
    mergedJson: Object.keys(merged).length > 0 ? JSON.stringify(merged) : '',
    conflicts,
  };
}

// ── Full preparation ──

export function prepareCivitaiLora(params: {
  shelf: CivitaiLoraShelfItem[];
  scope: CivitaiLoraScope;
  positivePrompt: string;
  rawAdditionalNetworksJson: string | undefined;
}): {
  modifiedPositive: string;
  mergedAdditionalNetworksJson: string;
  snapshot: CivitaiLoraSnapshot;
  warnings: CivitaiLoraWarning[];
} {
  const { shelf, scope, positivePrompt, rawAdditionalNetworksJson } = params;
  const warnings: CivitaiLoraWarning[] = [];

  const activeLoRAs = collectActiveLorasForScope(shelf, scope);

  // Warnings
  if (activeLoRAs.length > MAX_ACTIVE_LORAS) {
    warnings.push({
      type: 'too_many_active',
      message: `当前 flow 有 ${activeLoRAs.length} 个 LoRA 生效，可能影响质量和消耗`,
    });
  }

  for (const lora of activeLoRAs) {
    if (Math.abs(lora.strength) > STRONG_STRENGTH) {
      warnings.push({
        type: 'strong_effect',
        message: `${lora.name}: strength ${lora.strength} 可能产生过强效果`,
        loraId: lora.id,
      });
    }
    if (lora.mature === true) {
      warnings.push({
        type: 'mature_mismatch',
        message: `${lora.name} 标记为 Mature，请确认 allowMatureContent 已开启`,
        loraId: lora.id,
      });
    }
  }

  // Trigger injection — track per-LoRA actual injections for accurate snapshot
  const { perLora: perLoraInjected, all: allInjectedTokens, syntaxHits } =
    collectTriggerInjections(activeLoRAs, tokenizePrompt(positivePrompt));
  for (const { lora, text } of syntaxHits) {
    warnings.push({
      type: 'lora_trigger_syntax',
      message: `${lora.name}: 触发词 "${text}" 包含 <lora:> 语法 — Civitai 使用 strength 滑块，触发词应为普通 prompt 关键词`,
      loraId: lora.id,
    });
  }

  const triggerFragment = allInjectedTokens.join(', ');
  const modifiedPositive = triggerFragment
    ? [positivePrompt, triggerFragment].filter(Boolean).join(', ')
    : positivePrompt;

  // Network merge
  const { merged, mergedJson, conflicts } = mergeAdditionalNetworks(activeLoRAs, rawAdditionalNetworksJson);
  for (const air of conflicts) {
    warnings.push({
      type: 'air_conflict',
      message: `${air} 同时存在于书架和高级 JSON，生成时以书架强度为准`,
    });
  }

  // Snapshot — injectedTriggers reflects actual deduped injections
  const snapshot: CivitaiLoraSnapshot = {
    loras: activeLoRAs.map((lora) => ({
      id: lora.id,
      name: lora.name,
      air: lora.air.trim(),
      strength: lora.strength,
      scopes: lora.scopes,
      injectedTriggers: perLoraInjected.get(lora.id) ?? [],
    })),
    additionalNetworks: merged,
  };

  return { modifiedPositive, mergedAdditionalNetworksJson: mergedJson, snapshot, warnings };
}

// ── Preflight validation ──

export function validateShelfForGeneration(
  shelf: CivitaiLoraShelfItem[],
  scope: CivitaiLoraScope,
): {
  valid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const active = collectActiveLorasForScope(shelf, scope);

  for (const lora of active) {
    const airResult = validateLoraAir(lora.air);
    if (!airResult.valid) {
      errors.push(`${lora.name}: ${airResult.error}`);
    }
    if (Math.abs(lora.strength) < 0.05) {
      errors.push(`${lora.name}: strength 不能为 0（使用 enabled=false 来关闭 LoRA）`);
    }
  }

  if (active.length > MAX_ACTIVE_LORAS) {
    warnings.push(`当前 flow 有 ${active.length} 个 LoRA 生效，可能影响质量和消耗`);
  }

  for (const lora of active) {
    if (Math.abs(lora.strength) > STRONG_STRENGTH) {
      warnings.push(`${lora.name}: strength ${lora.strength} 效果可能过强`);
    }
    if (lora.mature === true) {
      warnings.push(`${lora.name} 标记为 Mature，请确认 allowMatureContent 已开启`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
