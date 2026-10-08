// App doc: docs/user-guide/pages/game-assistant.md §10
/**
 * WorldBuilderService — Story 3 "batch/complex" channel (D3 dual-engineering)
 *
 * Independent from AssistantService, focused on batch world-building tasks:
 * - Region generation (locations + NPCs + items)
 * - Batch NPC generation
 * - Free-text → structured data extraction
 *
 * Shares PayloadValidator/ConversationStore with AssistantService.
 * Does not reuse PipelineRunner (only AICall subset needed, see plan §3.2.1).
 */
import type { AIService } from '../../ai/ai-service';
import type { PromptTextSource } from '../../prompt/prompt-assembler';
import type { StateManager } from '../../core/state-manager';
import type { EngramManager } from '../../memory/engram/engram-manager';
import type { GamePack } from '../../types';
import type {
  ConversationStore,
  WorldBuilderTask,
  WorldBuilderResult,
  ProgressPayload,
} from '../assistant/types';
import { generateAssistantMessageId } from '../assistant/types';
import { parseAssistantPayload } from '../assistant/payload-parser';
import { PayloadValidator } from '../assistant/payload-validator';
import { appendMessageWithFifoTrim } from '../assistant/conversation-store';

import type { AssistantMessage, PayloadDraft } from '../assistant/types';
import { SYSTEM_PATHS } from '../../pipeline/system-paths';

export interface WorldBuilderLabels {
  messagePrefix: string;
  errorPrefix: string;
  noDataFallback: string;
}

const DEFAULT_LABELS: WorldBuilderLabels = {
  messagePrefix: '[World Builder]',
  errorPrefix: 'World build failed:',
  noDataFallback: 'AI produced no usable data. Adjust your instruction and retry.',
};

export interface WorldBuilderDeps {
  aiService: AIService;
  stateManager: StateManager;
  gamePack: GamePack | null;
  payloadValidator: PayloadValidator;
  engramManager?: EngramManager;
  conversationStore: ConversationStore;
  locale?: string;
  maxHistoryTurns?: number;
  labels?: WorldBuilderLabels;
  /** The prompts as the prompt page left them (item 2, PO 2026-10-05); without it, the pack's text. */
  prompts?: PromptTextSource;
}

export interface WorldBuilderPaths {
  relationships: string;
  locations: string;
  worldDescription: string;
  inventory: string;
  /** Field names within NPC/location records to include in compressed context */
  npcSummaryFields: string[];
  locationSummaryFields: string[];
  /** Field name used as "name" key in inventory items (for item name extraction) */
  itemNameField: string;
}

const NSFW_NPC_SECTION = `
   - **私密信息**（NSFW 模式已开启）— 必须作为一个名为 \`"私密信息"\` 的**嵌套对象**放在 NPC 档案中，格式如下：
     \`\`\`
     "私密信息": {
       "是否为处女/处男": true,
       "身体部位": [
         {"部位名称":"嘴","敏感度":40,"开发度":10,"特征描述":"50-120字具体形态/触感","特殊印记":""},
         {"部位名称":"胸部","敏感度":60,"开发度":20,"特征描述":"...","特殊印记":""},
         {"部位名称":"小穴","敏感度":50,"开发度":0,"特征描述":"...","特殊印记":""},
         {"部位名称":"屁穴","敏感度":30,"开发度":0,"特征描述":"...","特殊印记":""}
       ],
       "性格倾向":"...", "性取向":"...", "性癖好":["..."],
       "性渴望程度":30, "性交总次数":0, "性伴侣名单":[],
       "当前性状态":"...", "体液分泌状态":"...", "特殊体质":[]
     }
     \`\`\`
     ⚠ 私密信息字段**绝对不能**平铺在 NPC 根级！必须嵌套在 \`"私密信息": {...}\` 对象内。
     ⚠ 非处女/处男时追加必填：初夜夺取者/初夜时间/初夜描述(50-200字)
     ⚠ 处女=true → 性交总次数=0 且 性伴侣名单=[]
     ⚠ 所有数值字段（敏感度/开发度/性渴望程度/性交总次数）必须是 number 类型，禁止用字符串如"无法计算"
`;

// ── Conditional prompt sections for region generation ──

function buildNpcTaskBullets(npcCount: number): string {
  return `- **${npcCount} 个常驻 NPC**（分布在各子地点）
- **NPC 之间、NPC 与地点之间的关系**`;
}

function buildItemTaskBullet(itemCount: number): string {
  return `\n- **${itemCount} 个特色物品**（该区域可获得的物品，加入玩家背包）`;
}

function buildNpcJsonTemplate(nsfwSection: string): string {
  return `,
    {
      "target": "$.社交.关系",
      "op": "append-item",
      "value": {
        "名称": "<NPC中文名>",
        "性别": "<男|女|其他>",
        "年龄": 25,
        "类型": "<重点|普通>",
        "好感度": 50,
        "位置": "<所在地点名>",
        "描述": "<一句话身份/气质概述，30字以内>",
        "外貌描述": "<完整外貌段（脸、发、瞳、体型、气质），50-200字>",
        "身材描写": "<身高/体态/身体特征，30-120字>",
        "衣着风格": "<日常着装偏好（材质、色调、款式），30-100字>",
        "背景": "<出身/经历，50-200字>",
        "内心想法": "<当前内心状态>",
        "在做事项": "<当前正在做的事>",
        "性格特征": ["<标签1>", "<标签2>"],
        "核心性格特征": "<一句话锚定主性格>",
        "是否主要角色": false,
        "是否在场": false,
        "关系状态": "陌生人",
        "好感度突破条件": "<好感提升到下一阶段的条件>",
        "关系突破条件": "<关系升级触发条件>",
        "记忆": [],
        "私聊历史": [],
        "总结记忆": [],
        "关系网变量": [],
        "最后互动时间": ""
      }
    }` + nsfwSection;
}

const ITEM_JSON_TEMPLATE = `,
    {
      "target": "$.角色.背包.物品.<物品ID>",
      "op": "set-field",
      "value": {
        "名称": "<物品名>",
        "描述": "<物品描述>",
        "类型": "<物品类型>",
        "数量": 1
      },
      "rationale": "该区域特色物品"
    }`;

const KNOWLEDGE_FACTS_SECTION = `,
  "knowledge_facts": [
    {
      "sourceEntity": "<实体A>",
      "targetEntity": "<实体B>",
      "fact": "<A和B的关系描述>",
      "confidence": 1.0
    }
  ]`;

const ITEM_NOTE = `\n**注意：** \`角色.背包.物品\` 是 Record<物品ID, Item> 结构（不是数组）。每个物品用 \`set-field\` 写入 \`$.角色.背包.物品.<自动生成的物品ID>\`。物品ID 格式：\`<类型>_<时间戳13位>_<随机3字符>\`（如 \`weapon_1716000000_abc\`）。\n`;

function buildNpcConstraints(nsfwContent: string): string {
  return `4. **NPC 字段完整** — 每个 NPC 必须包含示例中的**全部字段**，禁止缺少任何字段
${nsfwContent ? nsfwContent + '\n' : ''}5. **NPC 类型** — 必须为 \`"重点"\` 或 \`"普通"\`，不得使用职业/身份作为类型值
6. **NPC 位置存在** — NPC 的 \`位置\` 必须是已有地点或本次新建的地点
7. **关系网变量** — 保持空数组 \`[]\`（NPC 间关系统一写在 \`knowledge_facts\` 中）
8. **好感度合理** — 友好类 NPC 60-70，中立类 40-50，警惕类 20-30
9. **关系丰富** — 至少为每个 NPC 生成 1 条 knowledge_fact（与其他 NPC 或地点的关系）
10. **私聊历史不填** — NPC 的 \`私聊历史\` 字段设为 \`[]\`（由系统运行时维护）
11. **性格多样** — 每个 NPC 的性格、外貌、背景不重复，同场景多个 NPC 须有明显差异
`;
}

const ITEM_CONSTRAINTS = `12. **物品路径** — 物品写入路径 \`$.角色.背包.物品.<ID>\`，ID 自行生成（\`<类型>_<时间戳13位>_<随机3字符>\`）
`;

/**
 * Apply conditional section replacements for the region prompt template.
 * Sections like {{NPC_TASK_BULLETS}} are injected or removed based on task config.
 */
export function applyRegionConditionals(
  template: string,
  opts: { genNpcs: boolean; npcCount: number; genItems: boolean; itemCount: number; nsfwMode: boolean },
): string {
  const nsfwContent = opts.nsfwMode && opts.genNpcs ? NSFW_NPC_SECTION : '';

  return template
    .replace(/\{\{NPC_TASK_BULLETS\}\}/g, opts.genNpcs ? buildNpcTaskBullets(opts.npcCount) : '')
    .replace(/\{\{ITEM_TASK_BULLET\}\}/g, opts.genItems ? buildItemTaskBullet(opts.itemCount) : '')
    .replace(/\{\{LOCATION_NPC_VALUE\}\}/g, opts.genNpcs ? '["<常驻NPC名1>", "<常驻NPC名2>"]' : '[]')
    .replace(/\{\{NPC_JSON_TEMPLATE\}\}/g, opts.genNpcs ? buildNpcJsonTemplate(nsfwContent) : '')
    .replace(/\{\{ITEM_JSON_TEMPLATE\}\}/g, opts.genItems ? ITEM_JSON_TEMPLATE : '')
    .replace(/\{\{KNOWLEDGE_FACTS_SECTION\}\}/g, opts.genNpcs ? KNOWLEDGE_FACTS_SECTION : '')
    .replace(/\{\{ITEM_NOTE\}\}/g, opts.genItems ? ITEM_NOTE : '')
    .replace(/\{\{NPC_CONSTRAINTS\}\}/g, opts.genNpcs ? buildNpcConstraints(nsfwContent) : '')
    .replace(/\{\{ITEM_CONSTRAINTS\}\}/g, opts.genItems ? ITEM_CONSTRAINTS : '');
}

const PROMPT_KEYS: Record<string, string> = {
  region: 'worldBuilderBatchRegion',
  npcs: 'worldBuilderBatchNpcs',
  'from-description': 'worldBuilderFromDescription',
};

export class WorldBuilderService {
  private isExecuting = false;

  private maxTurns: number;
  private labels: WorldBuilderLabels;

  constructor(private deps: WorldBuilderDeps) {
    this.maxTurns = deps.maxHistoryTurns ?? 5;
    this.labels = deps.labels ?? DEFAULT_LABELS;
  }

  /** A prompt as the prompt page left it ('' when switched off); the pack's text without a registry. */
  private promptText(promptId: string): string {
    const packPrompts = this.deps.gamePack?.prompts;
    return this.deps.prompts ? this.deps.prompts.effectiveText(promptId, packPrompts) : (packPrompts?.[promptId] ?? '');
  }

  /**
   * Whether a task is currently executing.
   * Note: this is a snapshot — do not use as a concurrency gate.
   * The authoritative guard is inside execute() itself.
   */
  get busy(): boolean {
    return this.isExecuting;
  }

  async execute(
    sessionId: string,
    task: WorldBuilderTask,
    paths: WorldBuilderPaths,
    onProgress?: (payload: ProgressPayload) => void,
  ): Promise<WorldBuilderResult> {
    if (this.isExecuting) {
      throw new Error('[WorldBuilderService] already executing a task');
    }
    this.isExecuting = true;

    try {
      return await this.doExecute(sessionId, task, paths, onProgress);
    } finally {
      this.isExecuting = false;
    }
  }

  private async doExecute(
    sessionId: string,
    task: WorldBuilderTask,
    paths: WorldBuilderPaths,
    onProgress?: (payload: ProgressPayload) => void,
  ): Promise<WorldBuilderResult> {
    // Step 1: Context Assembly
    onProgress?.({
      i18nKey: 'assistant.worldBuilder.progress.context',
      message: '[Context] Compressing world state...',
    });
    const worldContext = compressWorldContext(this.deps.stateManager, paths);

    // Step 2: Prompt Selection + Template Substitution
    onProgress?.({
      i18nKey: 'assistant.worldBuilder.progress.prompt',
      message: '[Prompt] Preparing prompt...',
    });
    const promptKey = PROMPT_KEYS[task.type];
    if (!promptKey) {
      return this.buildErrorResult(sessionId, task, `Unsupported task type: ${task.type}`);
    }
    const promptTemplate = this.promptText(promptKey);
    if (!promptTemplate) {
      return this.buildErrorResult(sessionId, task, `Prompt "${promptKey}" not found in game pack`);
    }

    const npcCount = Math.max(0, task.config?.npcCount ?? 5);
    const subLocCount = task.config?.subLocationCount ?? 3;
    const genNpcs = npcCount > 0;
    const genItems = task.config?.generateItems !== false;
    const itemCount = Math.max(0, task.config?.itemCount ?? 3);
    const nsfwMode = this.deps.stateManager.get<boolean>(SYSTEM_PATHS.nsfwMode) === true;

    // Apply conditional sections BEFORE user instruction to prevent marker injection
    const prompt = applyRegionConditionals(promptTemplate, { genNpcs, npcCount, genItems, itemCount, nsfwMode })
      .replace(/\{EXISTING_WORLD_CONTEXT\}/g, worldContext)
      .replace(/\{USER_INSTRUCTION\}/g, task.userInstruction)
      .replace(/\{NPC_COUNT\}/g, String(npcCount))
      .replace(/\{SUB_LOCATION_COUNT\}/g, String(subLocCount))
      .replace(/\{ITEM_COUNT\}/g, String(itemCount));

    // Step 3: AI Call (non-streaming — batch needs complete JSON)
    onProgress?.({
      i18nKey: 'assistant.worldBuilder.progress.generating',
      message: '[AI] Generating world data...',
    });

    let aiResponse: string;
    try {
      const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
      const jailbreak = this.promptText('assistantJailbreak').trim();
      if (jailbreak) {
        messages.push({ role: 'system', content: jailbreak });
      }
      messages.push({ role: 'system', content: prompt });
      messages.push({ role: 'user', content: 'Please generate the data as instructed above.' });

      aiResponse = await this.deps.aiService.generate({
        messages,
        stream: false,
        usageType: 'world_builder',
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return this.buildErrorResult(sessionId, task, errorMsg);
    }

    // Step 4: Response Parsing
    onProgress?.({
      i18nKey: 'assistant.worldBuilder.progress.parsing',
      message: '[Parse] Analyzing response...',
    });
    const parsed = parseAssistantPayload(aiResponse);
    if (!parsed || parsed.patches.length === 0) {
      return this.buildNoDataResult(sessionId, task, aiResponse);
    }

    // Step 5: Validation
    onProgress?.({
      i18nKey: 'assistant.worldBuilder.progress.validating',
      message: '[Validate] Checking patches...',
    });
    const validated = this.deps.payloadValidator.validate(parsed);
    const draft: PayloadDraft = {
      raw: parsed,
      validated,
      status: 'pending',
    };

    // Step 6: Conversation Integration
    const session = await this.deps.conversationStore.load(sessionId);

    const userMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'user',
      content: `${this.labels.messagePrefix} ${task.userInstruction}`,
      timestamp: Date.now(),
    };
    appendMessageWithFifoTrim(session, userMessage, this.maxTurns);

    const assistantMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'assistant',
      content: parsed.summary || aiResponse,
      timestamp: Date.now(),
      payloadDraft: draft,
    };
    appendMessageWithFifoTrim(session, assistantMessage, this.maxTurns);

    await this.deps.conversationStore.save(session);

    // Step 7: Return
    return {
      userMessage,
      assistantMessage,
      knowledgeFacts: parsed.knowledgeFacts,
    };
  }

  private async buildErrorResult(
    sessionId: string,
    task: WorldBuilderTask,
    errorMessage: string,
  ): Promise<WorldBuilderResult> {
    const session = await this.deps.conversationStore.load(sessionId);

    const userMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'user',
      content: `${this.labels.messagePrefix} ${task.userInstruction}`,
      timestamp: Date.now(),
    };
    appendMessageWithFifoTrim(session, userMessage, this.maxTurns);

    const systemMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'system',
      content: `${this.labels.errorPrefix} ${errorMessage}`,
      timestamp: Date.now(),
      systemKind: 'ai-error',
    };
    appendMessageWithFifoTrim(session, systemMessage, this.maxTurns);

    await this.deps.conversationStore.save(session);

    return {
      userMessage,
      assistantMessage: systemMessage,
    };
  }

  private async buildNoDataResult(
    sessionId: string,
    task: WorldBuilderTask,
    rawAiResponse: string,
  ): Promise<WorldBuilderResult> {
    const session = await this.deps.conversationStore.load(sessionId);

    const userMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'user',
      content: `${this.labels.messagePrefix} ${task.userInstruction}`,
      timestamp: Date.now(),
    };
    appendMessageWithFifoTrim(session, userMessage, this.maxTurns);

    const assistantMessage: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'assistant',
      content: rawAiResponse || this.labels.noDataFallback,
      timestamp: Date.now(),
    };
    appendMessageWithFifoTrim(session, assistantMessage, this.maxTurns);

    await this.deps.conversationStore.save(session);

    return { userMessage, assistantMessage };
  }
}

/**
 * Compress world state for AI context — keeps only essential fields to reduce token count.
 * All field names come from the paths config to respect engine/content separation (CLAUDE.md §4).
 */
export function compressWorldContext(stateManager: StateManager, paths: WorldBuilderPaths): string {
  const npcs = stateManager.get<Array<Record<string, unknown>>>(paths.relationships) ?? [];
  const locations = stateManager.get<Array<Record<string, unknown>>>(paths.locations) ?? [];
  const worldDesc = stateManager.get<string>(paths.worldDescription) ?? '';
  const itemsObj = stateManager.get<Record<string, Record<string, unknown>>>(paths.inventory) ?? {};
  const nameField = paths.itemNameField;
  const itemNames = Object.values(itemsObj)
    .map(i => (typeof i[nameField] === 'string' ? i[nameField] as string : ''))
    .filter(Boolean);

  const npcSummary = npcs.map(n => pickFields(n, paths.npcSummaryFields));
  const locationSummary = locations.map(l => pickFields(l, paths.locationSummaryFields));

  return JSON.stringify({
    worldDescription: worldDesc,
    existingNPCs: npcSummary,
    existingLocations: locationSummary,
    existingItems: itemNames,
  }, null, 2);
}

function pickFields(record: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in record) result[f] = record[f];
  }
  return result;
}
