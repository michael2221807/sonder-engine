// App doc: docs/user-guide/pages/creation.md §2.8
/**
 * PresetAIGenerator — AI 推演用户自定义创角预设
 *
 * 用户在创角时点"✦ AI 生成"按钮 → AIPresetGenModal 收集用户的"种子描述" →
 * 调本服务 → AI 按 customSchema 字段返回 JSON → 解析后回灌到 CustomPresetModal
 * 让用户审阅/编辑，最后保存（走 addCustomPreset, generatedBy='ai'）。
 *
 * 关键设计：
 *
 * 1. **复用主游戏 API 配置**：调 aiService.generate({ usageType: 'main' })，
 *    保证用户配的"主游戏 API"被使用 —— 不需要为创角生成单独配 API。
 *
 * 2. **注入 jailbreak 提示词**：从 GamePack 取 `narratorEnforcement` 模块
 *    （主回合也用同一段）作为 system 消息前置。这避免了某些 NSFW / 黑暗题材的
 *    自定义生成被模型的内置 refusal 直接挡掉。
 *
 * 3. **结构化输出契约**：AI 必须返回 ```{ "name": "...", "description": "...", ... }```，
 *    字段集由 customSchema.fields 决定。解析时容错处理 markdown 围栏 / 多余文本，
 *    复用 `findBalancedJsonBlocks` + JSON.parse fallback。
 *
 * 4. **失败降级**：API 不可用 / JSON 解析失败 / 必填字段缺失 → 抛错，
 *    UI 层捕获后用 toast 通知用户并保留模态供其手动填写。
 *
 * 对应 docs/status/research-custom-creation-presets-2026-04-14.md Phase 3。
 */
import type { AIService } from '../ai/ai-service';
import type { AIMessage } from '../ai/types';
import type { GamePack, CustomPresetSchema } from '../types';
import { findBalancedJsonBlocks, stripMarkdownFences } from '../ai/json-extract';

// ─── 参数 / 结果 ───

export interface GeneratePresetInput {
  /** Preset 类型 key（如 "worlds", "origins"），影响生成提示词措辞 */
  presetType: string;
  /** 步骤显示标签（如 "世界", "出身"），用在 prompt 里更自然 */
  stepLabel: string;
  /** 字段 schema —— 决定 AI 必须返回哪些 key */
  schema: CustomPresetSchema;
  /** 用户的种子描述（自然语言提示） */
  userSeed: string;
}

export interface GeneratePresetResult {
  /** AI 返回的字段对象（已按 schema 校验过 required，但未做范围 clamp） */
  fields: Record<string, unknown>;
  /** AI 原始响应文本，供调试 */
  rawResponse: string;
}

// ─── 内部工具 ───

/**
 * 把 customSchema 转成给 AI 看的"字段说明"片段
 *
 * 例：
 * ```
 * - "name" (text, 必填): 世界名称（如「九霄界」）
 * - "description" (textarea): 世界描述
 * - "talent_cost" (number, 范围 0-50): 天资点花费
 * ```
 */
function describeSchema(schema: CustomPresetSchema): string {
  return schema.fields
    .map((f) => {
      const parts: string[] = [`"${f.key}"`, `(${f.type}`];
      if (f.required) parts.push(', 必填');
      if (f.type === 'number') {
        const range: string[] = [];
        if (typeof f.min === 'number') range.push(`min=${f.min}`);
        if (typeof f.max === 'number') range.push(`max=${f.max}`);
        if (range.length) parts.push(`, ${range.join(' ')}`);
      } else if (f.type === 'select' && f.options?.length) {
        parts.push(`, 只能是 ${f.options.map((option) => JSON.stringify(option)).join(' / ')}`);
      } else if (f.type === 'checkbox') {
        parts.push(', boolean true/false');
      }
      parts[parts.length - 1] = parts[parts.length - 1] + ')';
      const head = parts.join('');
      const desc = f.placeholder ? `: ${f.placeholder}` : `: ${f.label}`;
      return `- ${head}${desc}`;
    })
    .join('\n');
}

/**
 * 剥离 `<thinking>...</thinking>` / `<think>...</think>` 块（CR-2026-04-14 P1-2）
 *
 * 部分模型即便被要求直接输出仍会先 dump 思维链。在 thinking 内常含半成品 JSON，
 * 旧实现会优先选中它。统一在解析前剥离，避免污染。
 */
function stripThinkingTags(text: string): string {
  return text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}

/**
 * 解析 AI 响应 → 字段对象（CR-2026-04-14 P1-2 修复）
 *
 * 流程：
 * 1. 剥离 `<thinking>` 标签（避免 CoT 内的半成品 JSON 被选中）
 * 2. 剥离 markdown 围栏
 * 3. 用平衡括号扫描找所有顶层 JSON 块
 * 4. 对每个合法 JSON 对象计算"必填字段命中数 + schema 字段命中数"加权得分
 * 5. **选择得分最高**（同分时**取最后一个** —— CoT 通常在前，最终答案在后）
 *
 * 旧版本只取首块的启发式会在"半成品 → 修正版"输出场景下选错；新版本以"覆盖
 * 必填字段最全 + 同分取最末"为优先级。
 */
function parsePresetResponse(
  raw: string,
  schema: CustomPresetSchema,
): Record<string, unknown> {
  const detagged = stripThinkingTags(raw);
  const cleaned = stripMarkdownFences(detagged);
  const blocks = findBalancedJsonBlocks(cleaned);

  const requiredKeys = new Set(schema.fields.filter((f) => f.required).map((f) => f.key));
  const schemaKeys = new Set(schema.fields.map((f) => f.key));

  type Candidate = { obj: Record<string, unknown>; score: number; index: number };
  const candidates: Candidate[] = [];

  blocks.forEach((blk, idx) => {
    try {
      const obj = JSON.parse(blk) as Record<string, unknown>;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      const keys = Object.keys(obj);
      const requiredHits = keys.filter((k) => requiredKeys.has(k)).length;
      const schemaHits = keys.filter((k) => schemaKeys.has(k)).length;
      if (schemaHits === 0) return; // 至少含一个 schema key 才视为候选
      // 必填命中权重远大于普通 schema 命中（10:1）—— 必填覆盖全的 block 总是优先
      const score = requiredHits * 10 + schemaHits;
      candidates.push({ obj, score, index: idx });
    } catch {
      /* 当前块非合法 JSON */
    }
  });

  if (candidates.length > 0) {
    // 同分时取出现最晚的（CoT 通常在前 → 最终答案在后）
    candidates.sort((a, b) => b.score - a.score || b.index - a.index);
    return candidates[0].obj;
  }

  // 最后兜底：把整个文本当 JSON 试一次
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch {
    /* ignore */
  }

  throw new Error('AI 响应无法解析为 JSON 对象');
}

/**
 * 校验 AI 返回的字段对象 — 必填字段必须存在且非空
 *
 * 不做严格类型检查 / 范围 clamp（让 CustomPresetModal 显示给用户复核时再处理）；
 * 但必填字段缺失时直接抛错让 UI 提示用户重试。
 */
function validateRequired(
  fields: Record<string, unknown>,
  schema: CustomPresetSchema,
): void {
  const missing: string[] = [];
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = fields[f.key];
    if (
      v === undefined
      || v === null
      || (typeof v === 'string' && v.trim() === '')
      || (Array.isArray(v) && v.length === 0)
    ) {
      missing.push(f.label);
    }
  }
  if (missing.length > 0) {
    throw new Error(`AI 输出缺失必填字段：${missing.join('、')}`);
  }
}

/**
 * 把 schema 字段过滤出来 + 类型规范化（CR-2026-04-14 P1-3 修复）
 *
 * - 文本字段：null → ''；其他非字符串值 String() 转换
 * - number 字段：
 *   - 必填 → 无法解析为有限数时**抛错**（旧版本静默归 0，会让用户拿到错误数据）
 *   - 非必填 + 字段未提供 → 跳过
 *   - 非必填 + 提供了但解析失败 → 也抛错（用户至少能看到错误，重新生成）
 */
function pickSchemaFields(
  raw: Record<string, unknown>,
  schema: CustomPresetSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fieldErrors: string[] = [];
  for (const f of schema.fields) {
    if (!(f.key in raw)) continue;
    const v = raw[f.key];
    if (f.type === 'number') {
      // Number(null) === 0 / Number('') === 0 / Number(true) === 1 都是 JS 的隐式转换，
      // 全部视为"AI 没给出真正的数字"。仅 number 类型 + 可解析为有限数的字符串通过。
      const isAcceptable =
        typeof v === 'number' ? Number.isFinite(v)
        : typeof v === 'string' ? v.trim() !== '' && Number.isFinite(Number(v))
        : false;
      if (!isAcceptable) {
        fieldErrors.push(`${f.label}（值为 ${JSON.stringify(v)}）`);
        continue;
      }
      out[f.key] = Number(v);
    } else if (f.type === 'checkbox') {
      if (v === true || v === false) {
        out[f.key] = v;
      } else if (v === 'true' || v === 'false') {
        out[f.key] = v === 'true';
      } else {
        fieldErrors.push(`${f.label}（值为 ${JSON.stringify(v)}）`);
      }
    } else if (f.type === 'select') {
      const selected = Array.isArray(v) && f.key === 'genres' ? v[0] : v;
      if (typeof selected !== 'string' || (f.options && !f.options.includes(selected))) {
        fieldErrors.push(`${f.label}（值为 ${JSON.stringify(v)}）`);
      } else {
        out[f.key] = f.key === 'genres' ? [selected] : selected;
      }
    } else {
      out[f.key] = typeof v === 'string' ? v : v == null ? '' : String(v);
    }
  }
  if (fieldErrors.length > 0) {
    throw new Error(`AI 输出的数值字段无法解析或字段类型/取值无效：${fieldErrors.join('、')}`);
  }
  return out;
}

// ─── PresetAIGenerator ───

export class PresetAIGenerator {
  constructor(private aiService: AIService, private gamePack: GamePack | null) {}

  /**
   * 主入口 — 调 AI 生成一条预设条目
   *
   * @throws Error 当 AI 调用失败 / JSON 解析失败 / 必填字段缺失
   */
  async generate(input: GeneratePresetInput): Promise<GeneratePresetResult> {
    const { presetType, stepLabel, schema, userSeed } = input;

    // ── 1. 构造 system prompt：jailbreak + 任务说明 ──
    const messages: AIMessage[] = [];

    // jailbreak —— CR-2026-04-14 P1-1 修复
    // 优先用专门为创角生成调优的 `creationGenJailbreak`（不含主回合 JSON 约束、
    // 专门为 NSFW/暗黑题材的拒绝问题写过措辞）；缺失时 fallback 到 narratorEnforcement
    // 以保持兼容（旧 pack 没有 creationGenJailbreak）。
    const jailbreak = (
      this.gamePack?.prompts['creationGenJailbreak']?.trim() ||
      this.gamePack?.prompts['narratorEnforcement']?.trim()
    );
    if (jailbreak) {
      messages.push({ role: 'system', content: jailbreak });
    }

    // 任务说明
    const taskPrompt = this.buildTaskPrompt(presetType, stepLabel, schema);
    messages.push({ role: 'system', content: taskPrompt });

    // 用户种子（可选，空时让 AI 自由发挥）
    const userMessage = userSeed.trim().length > 0
      ? userSeed.trim()
      : `请根据上面的设定，生成一条新的「${stepLabel}」条目。`;
    messages.push({ role: 'user', content: userMessage });

    // ── 2. 调 AI ── usageType: 'main' 复用主游戏 API 配置（用户决定）
    let raw: string;
    try {
      raw = await this.aiService.generate({
        messages,
        usageType: 'main',
        stream: false,
      });
    } catch (err) {
      throw new Error(`AI 调用失败：${err instanceof Error ? err.message : String(err)}`);
    }

    if (!raw || raw.trim().length === 0) {
      throw new Error('AI 返回了空内容');
    }

    // ── 3. 解析 + 校验 + 规范化 ──
    const parsed = parsePresetResponse(raw, schema);
    const picked = pickSchemaFields(parsed, schema);
    validateRequired(picked, schema);

    return { fields: picked, rawResponse: raw };
  }

  /**
   * 构造任务 prompt
   *
   * 内含：
   * - 生成什么（preset 类型 + 字段 schema）
   * - 字段 schema 细节
   * - 输出格式严格要求（仅 JSON，无围栏，无解释）
   */
  private buildTaskPrompt(
    presetType: string,
    stepLabel: string,
    schema: CustomPresetSchema,
  ): string {
    const schemaDesc = describeSchema(schema);
    return [
      `# 任务：生成一条「${stepLabel}」自定义预设条目`,
      '',
      `你将为一个角色扮演游戏的创角系统生成一条新的"${stepLabel}"选项（preset 类型: \`${presetType}\`）。`,
      '玩家会在创角界面看到这条选项与游戏内置选项并排显示，可以选中它开始游戏。',
      '',
      '## 字段定义',
      '',
      '必须返回包含以下字段的 JSON 对象：',
      '',
      schemaDesc,
      '',
      '## 输出规则',
      '',
      '1. **直接输出 JSON 对象**，不要任何解释、不要 markdown 围栏、不要 `<thinking>` 标签',
      '2. 必填字段不可省略；非必填字段视用户描述自由决定',
      '3. `description` / `name` 等文本字段要具体、有画面感，匹配游戏世界观',
      '4. number 字段必须在指定范围内',
      '5. 不要返回字段以外的额外 key',
      '',
      '## 示例输出格式',
      '',
      '```',
      '{"name": "示例名称", "description": "...", "talent_cost": 5}',
      '```',
      '（实际输出**不要**带 markdown 围栏 ``` ）',
    ].join('\n');
  }
}
