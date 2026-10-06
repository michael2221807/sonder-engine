/**
 * WorldBuilderService — Story 3 Phase 3 tests
 *
 * Coverage:
 * - execute with type='region' → parses AI response, creates payloadDraft, writes to conversation
 * - execute with type='npcs' → NPC_COUNT substitution, correct prompt key
 * - execute with type='from-description' → correct prompt key
 * - AI failure → error result with ai-error system message
 * - AI returns no patches → no-data result
 * - concurrency guard (busy flag)
 * - compressWorldContext helper
 * - progress callbacks
 */
import { describe, it, expect } from 'vitest';
import { WorldBuilderService, compressWorldContext, applyRegionConditionals, type WorldBuilderPaths } from './world-builder-service';
import { InMemoryConversationStore } from '../assistant/conversation-store';
import { PayloadValidator } from '../assistant/payload-validator';
import type { StateManager } from '../../core/state-manager';
import type { GamePack } from '../../types';
import type { AIService } from '../../ai/ai-service';
import { PromptRegistry } from '../../prompt/prompt-registry';
import { PromptAssembler } from '../../prompt/prompt-assembler';
import { TemplateEngine } from '../../prompt/template-engine';
import { isPromptAlwaysOn } from '../../prompt/builtin-slots';

class FakeStateManager {
  state: Record<string, unknown>;
  constructor(s: Record<string, unknown>) { this.state = JSON.parse(JSON.stringify(s)); }
  get<T>(p: string): T | undefined {
    const segs = p.split('.').filter(Boolean);
    let cur: unknown = this.state;
    for (const s of segs) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[s];
      else return undefined;
    }
    return cur as T;
  }
  toSnapshot() { return JSON.parse(JSON.stringify(this.state)); }
  rollbackTo(s: Record<string, unknown>) { this.state = JSON.parse(JSON.stringify(s)); }
}

const SCHEMA = {
  properties: {
    社交: {
      properties: {
        关系: {
          type: 'array',
          'x-assistant-editable': true,
          items: { type: 'object', properties: { 名称: { type: 'string' }, 类型: { type: 'string' } } },
        },
      },
    },
    世界: {
      properties: {
        地点信息: {
          type: 'array',
          'x-assistant-editable': true,
          items: { type: 'object', properties: { 名称: { type: 'string' } } },
        },
        描述: { type: 'string' },
      },
    },
    背包: {
      'x-assistant-editable': true,
      properties: {
        物品: { type: 'object', additionalProperties: { type: 'object' } },
      },
    },
    系统: { properties: { nsfwMode: { type: 'boolean' } } },
  },
};

const REGION_TEMPLATE = `REGION_PROMPT {EXISTING_WORLD_CONTEXT} {USER_INSTRUCTION} {SUB_LOCATION_COUNT} subs
{{NPC_TASK_BULLETS}}{{ITEM_TASK_BULLET}}
"NPC": {{LOCATION_NPC_VALUE}}
patches[{{NPC_JSON_TEMPLATE}}{{ITEM_JSON_TEMPLATE}}]{{KNOWLEDGE_FACTS_SECTION}}
{{ITEM_NOTE}}
{{NPC_CONSTRAINTS}}{{ITEM_CONSTRAINTS}}`;

const PACK: GamePack = {
  prompts: {
    assistantJailbreak: 'JAILBREAK_PROMPT',
    worldBuilderBatchRegion: REGION_TEMPLATE,
    worldBuilderBatchNpcs: 'NPCS_PROMPT {NPC_COUNT} {EXISTING_WORLD_CONTEXT} {USER_INSTRUCTION}',
    worldBuilderFromDescription: 'DESC_PROMPT {EXISTING_WORLD_CONTEXT} {USER_INSTRUCTION}',
  },
  stateSchema: SCHEMA,
} as unknown as GamePack;

const TEST_PATHS: WorldBuilderPaths = {
  relationships: '社交.关系',
  locations: '世界.地点信息',
  worldDescription: '世界.描述',
  inventory: '角色.背包.物品',
  npcSummaryFields: ['名称', '类型', '位置', '核心性格特征', '是否主要角色'],
  locationSummaryFields: ['名称', '类型', '上级', '连接'],
  itemNameField: '名称',
};

const INITIAL_STATE = {
  社交: { 关系: [{ 名称: '张三', 类型: '友人', 位置: '城中', 核心性格特征: '热情', 是否主要角色: false }] },
  世界: { 地点信息: [{ 名称: '城中', 类型: '城镇', 上级: null, 连接: [] }], 描述: '一个繁华的城镇' },
  角色: { 背包: { 物品: { sword_001: { 名称: '铁剑' } } } },
  系统: { nsfwMode: false },
};

function makeAIService(response: string, shouldThrow = false) {
  const calls: Array<{ messages: unknown; usageType?: string }> = [];
  const aiService = {
    async generate(options: { messages: unknown; usageType?: string }) {
      calls.push({ messages: options.messages, usageType: options.usageType });
      if (shouldThrow) throw new Error('network error');
      return response;
    },
  } as unknown as AIService;
  return { aiService, calls };
}

const VALID_AI_RESPONSE = JSON.stringify({
  summary: '创建了市集区域',
  patches: [
    { target: '$.社交.关系', op: 'append-item', value: { 名称: '李四', 类型: '商人', 好感度: 50 } },
  ],
  knowledge_facts: [
    { sourceEntity: '张三', targetEntity: '李四', fact: '张三是李四的常客', confidence: 1.0 },
  ],
});

function makeService(aiResponse: string, shouldThrow = false) {
  const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
  const store = new InMemoryConversationStore();
  const validator = new PayloadValidator({ stateManager: sm as unknown as StateManager, gamePack: PACK });
  const { aiService, calls } = makeAIService(aiResponse, shouldThrow);

  const svc = new WorldBuilderService({
    aiService,
    stateManager: sm as unknown as StateManager,
    gamePack: PACK,
    payloadValidator: validator,
    conversationStore: store,
  });

  return { svc, sm, store, calls };
}

// ─── execute — region ──────────────────────────────────────

describe('WorldBuilderService — execute region', () => {
  it('parses AI response and returns payloadDraft with patches + knowledgeFacts', async () => {
    const { svc } = makeService(VALID_AI_RESPONSE);

    const result = await svc.execute('default', { type: 'region', userInstruction: '在城北创建市集' }, TEST_PATHS);

    expect(result.assistantMessage.payloadDraft).toBeDefined();
    expect(result.assistantMessage.payloadDraft!.status).toBe('pending');
    expect(result.assistantMessage.payloadDraft!.raw.patches).toHaveLength(1);
    expect(result.knowledgeFacts).toHaveLength(1);
    expect(result.knowledgeFacts![0].fact).toBe('张三是李四的常客');
  });

  it('writes user + assistant messages to conversation store', async () => {
    const { svc, store } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', { type: 'region', userInstruction: '创建市集' }, TEST_PATHS);

    const session = await store.load('default');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe('user');
    expect(session.messages[0].content).toContain('[World Builder]');
    expect(session.messages[1].role).toBe('assistant');
    expect(session.messages[1].payloadDraft).toBeDefined();
  });

  it('passes usageType=world_builder to aiService', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    expect(calls[0].usageType).toBe('world_builder');
  });

  it('substitutes {EXISTING_WORLD_CONTEXT} and {USER_INSTRUCTION} in prompt', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', { type: 'region', userInstruction: '创建森林' }, TEST_PATHS);

    const msgs = calls[0].messages as Array<{ role: string; content: string }>;
    // msgs[0] = jailbreak, msgs[1] = world builder prompt, msgs[2] = user
    const systemMsg = msgs[1];
    expect(systemMsg.content).toContain('一个繁华的城镇');
    expect(systemMsg.content).toContain('创建森林');
    expect(systemMsg.content).not.toContain('{EXISTING_WORLD_CONTEXT}');
    expect(systemMsg.content).not.toContain('{USER_INSTRUCTION}');
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).not.toContain('创建森林');
  });

  it('injects assistantJailbreak as first system message before prompt', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    const msgs = calls[0].messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'JAILBREAK_PROMPT' });
    expect(msgs[1].role).toBe('system');
    expect(msgs[1].content).toContain('REGION_PROMPT');
    expect(msgs[2].role).toBe('user');
  });

  it('skips jailbreak when gamePack has no assistantJailbreak prompt', async () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const store = new InMemoryConversationStore();
    const packNoJailbreak = {
      prompts: {
        worldBuilderBatchRegion: 'REGION_PROMPT {EXISTING_WORLD_CONTEXT} {USER_INSTRUCTION}',
      },
      stateSchema: SCHEMA,
    } as unknown as GamePack;
    const validator = new PayloadValidator({ stateManager: sm as unknown as StateManager, gamePack: packNoJailbreak });
    const { aiService, calls } = makeAIService(VALID_AI_RESPONSE);

    const svc = new WorldBuilderService({
      aiService,
      stateManager: sm as unknown as StateManager,
      gamePack: packNoJailbreak,
      payloadValidator: validator,
      conversationStore: store,
    });

    await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    const msgs = calls[0].messages as Array<{ role: string; content: string }>;
    expect(msgs[0].content).toContain('REGION_PROMPT');
    expect(msgs[1].role).toBe('user');
  });
});

// ─── execute — npcs ────────────────────────────────────────

describe('WorldBuilderService — execute npcs', () => {
  it('substitutes {NPC_COUNT} from task config', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'npcs',
      userInstruction: '生成商人NPC',
      config: { npcCount: 8 },
    }, TEST_PATHS);

    const systemMsg = (calls[0].messages as Array<{ role: string; content: string }>)[1];
    expect(systemMsg.content).toContain('8');
    expect(systemMsg.content).not.toContain('{NPC_COUNT}');
  });

  it('defaults NPC_COUNT to 5 when not specified', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', { type: 'npcs', userInstruction: 'test' }, TEST_PATHS);

    const systemMsg = (calls[0].messages as Array<{ role: string; content: string }>)[1];
    expect(systemMsg.content).toContain('5');
  });
});

// ─── execute — from-description ────────────────────────────

describe('WorldBuilderService — execute from-description', () => {
  it('uses worldBuilderFromDescription prompt', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'from-description',
      userInstruction: '城中有一个老铁匠，名叫王铁锤...',
    }, TEST_PATHS);

    const systemMsg = (calls[0].messages as Array<{ role: string; content: string }>)[1];
    expect(systemMsg.content).toContain('DESC_PROMPT');
  });
});

// ─── failure handling ──────────────────────────────────────

describe('WorldBuilderService — failure handling', () => {
  it('AI network error → error result with ai-error system message', async () => {
    const { svc, store } = makeService('', true);

    const result = await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    expect(result.assistantMessage.systemKind).toBe('ai-error');
    expect(result.assistantMessage.content).toContain('network error');

    const session = await store.load('default');
    expect(session.messages.some(m => m.systemKind === 'ai-error')).toBe(true);
  });

  it('AI returns non-JSON → no-data result', async () => {
    const { svc } = makeService('I cannot help with that request.');

    const result = await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    expect(result.assistantMessage.payloadDraft).toBeUndefined();
    expect(result.assistantMessage.content).toContain('I cannot help');
  });

  it('AI returns JSON with empty patches → no-data result', async () => {
    const { svc } = makeService(JSON.stringify({ summary: 'nothing', patches: [] }));

    const result = await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);

    expect(result.assistantMessage.payloadDraft).toBeUndefined();
  });

  it('unsupported task type → error result', async () => {
    const { svc } = makeService(VALID_AI_RESPONSE);

    const result = await svc.execute('default', {
      type: 'st-import' as 'region',
      userInstruction: 'test',
    }, TEST_PATHS);

    expect(result.assistantMessage.systemKind).toBe('ai-error');
  });

  it('missing prompt in pack → error result', async () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const store = new InMemoryConversationStore();
    const validator = new PayloadValidator({ stateManager: sm as unknown as StateManager, gamePack: PACK });
    const { aiService } = makeAIService(VALID_AI_RESPONSE);

    const svc = new WorldBuilderService({
      aiService,
      stateManager: sm as unknown as StateManager,
      gamePack: { prompts: {} } as unknown as GamePack,
      payloadValidator: validator,
      conversationStore: store,
    });

    const result = await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS);
    expect(result.assistantMessage.systemKind).toBe('ai-error');
  });
});

// ─── concurrency ───────────────────────────────────────────

describe('WorldBuilderService — concurrency', () => {
  it('busy flag is true during execution', async () => {
    const { svc } = makeService(VALID_AI_RESPONSE);

    expect(svc.busy).toBe(false);

    let busyDuringExec = false;
    const originalExecute = svc.execute.bind(svc);
    const promise = originalExecute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS, () => {
      busyDuringExec = svc.busy;
    });

    await promise;
    expect(busyDuringExec).toBe(true);
    expect(svc.busy).toBe(false);
  });

  it('rejects concurrent execute calls', async () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const store = new InMemoryConversationStore();
    const validator = new PayloadValidator({ stateManager: sm as unknown as StateManager, gamePack: PACK });

    let resolveAI: (v: string) => void;
    const aiPromise = new Promise<string>(r => { resolveAI = r; });
    const aiService = {
      async generate() { return aiPromise; },
    } as unknown as AIService;

    const svc = new WorldBuilderService({
      aiService,
      stateManager: sm as unknown as StateManager,
      gamePack: PACK,
      payloadValidator: validator,
      conversationStore: store,
    });

    const first = svc.execute('default', { type: 'region', userInstruction: 'a' }, TEST_PATHS);
    await expect(svc.execute('default', { type: 'region', userInstruction: 'b' }, TEST_PATHS))
      .rejects.toThrow('already executing');

    resolveAI!(VALID_AI_RESPONSE);
    await first;
  });
});

// ─── compressWorldContext ──────────────────────────────────

describe('compressWorldContext', () => {
  it('compresses NPC to summary fields only', () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const result = compressWorldContext(sm as unknown as StateManager, TEST_PATHS);
    const parsed = JSON.parse(result);

    expect(parsed.existingNPCs).toHaveLength(1);
    expect(parsed.existingNPCs[0]).toEqual({
      名称: '张三', 类型: '友人', 位置: '城中', 核心性格特征: '热情', 是否主要角色: false,
    });
  });

  it('compresses locations to summary fields only', () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const result = compressWorldContext(sm as unknown as StateManager, TEST_PATHS);
    const parsed = JSON.parse(result);

    expect(parsed.existingLocations).toHaveLength(1);
    expect(parsed.existingLocations[0]['名称']).toBe('城中');
  });

  it('extracts item names from Record<id, Item>', () => {
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const result = compressWorldContext(sm as unknown as StateManager, TEST_PATHS);
    const parsed = JSON.parse(result);

    expect(parsed.existingItems).toEqual(['铁剑']);
  });

  it('handles empty state gracefully', () => {
    const sm = new FakeStateManager({});
    const result = compressWorldContext(sm as unknown as StateManager, TEST_PATHS);
    const parsed = JSON.parse(result);

    expect(parsed.existingNPCs).toEqual([]);
    expect(parsed.existingLocations).toEqual([]);
    expect(parsed.existingItems).toEqual([]);
    expect(parsed.worldDescription).toBe('');
  });
});

// ─── progress callbacks ────────────────────────────────────

describe('WorldBuilderService — progress', () => {
  it('calls onProgress at each step', async () => {
    const { svc } = makeService(VALID_AI_RESPONSE);
    const steps: string[] = [];

    await svc.execute('default', { type: 'region', userInstruction: 'test' }, TEST_PATHS,
      (payload) => steps.push(payload.message));

    expect(steps.length).toBeGreaterThanOrEqual(4);
    expect(steps[0]).toContain('Context');
    expect(steps[1]).toContain('Prompt');
    expect(steps[2]).toContain('AI');
    expect(steps[3]).toContain('Parse');
  });
});

// ─── applyRegionConditionals ─────────────────────────────

describe('applyRegionConditionals', () => {
  const TEMPLATE = `任务：
- 地点
{{NPC_TASK_BULLETS}}{{ITEM_TASK_BULLET}}
"NPC": {{LOCATION_NPC_VALUE}}
JSON[{{NPC_JSON_TEMPLATE}}{{ITEM_JSON_TEMPLATE}}]{{KNOWLEDGE_FACTS_SECTION}}
{{ITEM_NOTE}}约束：
{{NPC_CONSTRAINTS}}{{ITEM_CONSTRAINTS}}`;

  it('both NPC and items enabled → includes all sections', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: true, npcCount: 5, genItems: true, itemCount: 3, nsfwMode: false,
    });
    expect(result).toContain('5 个常驻 NPC');
    expect(result).toContain('NPC 之间');
    expect(result).toContain('3 个特色物品');
    expect(result).toContain('$.社交.关系');
    expect(result).toContain('$.角色.背包.物品');
    expect(result).toContain('knowledge_facts');
    expect(result).toContain('NPC 字段完整');
    expect(result).toContain('物品路径');
    expect(result).toContain('Record<物品ID');
    expect(result).toContain('"NPC": ["<常驻NPC名1>"');
  });

  it('NPC disabled → removes NPC sections, keeps items, location NPC=[]', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: false, npcCount: 0, genItems: true, itemCount: 2, nsfwMode: false,
    });
    expect(result).not.toContain('常驻 NPC');
    expect(result).not.toContain('NPC 之间');
    expect(result).not.toContain('$.社交.关系');
    expect(result).not.toContain('knowledge_facts');
    expect(result).not.toContain('NPC 字段完整');
    expect(result).toContain('"NPC": []');
    expect(result).toContain('2 个特色物品');
    expect(result).toContain('$.角色.背包.物品');
    expect(result).toContain('物品路径');
  });

  it('items disabled → removes item sections, keeps NPCs', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: true, npcCount: 3, genItems: false, itemCount: 0, nsfwMode: false,
    });
    expect(result).toContain('3 个常驻 NPC');
    expect(result).toContain('$.社交.关系');
    expect(result).toContain('knowledge_facts');
    expect(result).not.toContain('特色物品');
    expect(result).not.toContain('$.角色.背包.物品');
    expect(result).not.toContain('物品路径');
    expect(result).not.toContain('Record<物品ID');
  });

  it('both disabled → only location content remains', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: false, npcCount: 0, genItems: false, itemCount: 0, nsfwMode: false,
    });
    expect(result).toContain('地点');
    expect(result).not.toContain('常驻 NPC');
    expect(result).not.toContain('特色物品');
    expect(result).not.toContain('$.社交.关系');
    expect(result).not.toContain('$.角色.背包.物品');
    expect(result).not.toContain('knowledge_facts');
    expect(result).not.toContain('NPC 字段完整');
    expect(result).not.toContain('物品路径');
  });

  it('NSFW mode + NPC enabled → includes NSFW section', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: true, npcCount: 5, genItems: false, itemCount: 0, nsfwMode: true,
    });
    expect(result).toContain('私密信息');
    expect(result).toContain('NSFW');
  });

  it('NSFW mode + NPC disabled → NSFW section omitted', () => {
    const result = applyRegionConditionals(TEMPLATE, {
      genNpcs: false, npcCount: 0, genItems: true, itemCount: 3, nsfwMode: true,
    });
    expect(result).not.toContain('私密信息');
  });
});

// ─── integration: region with npcCount=0 ─────────────────

describe('WorldBuilderService — region conditional prompts', () => {
  it('npcCount=0 → prompt omits NPC sections', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'region',
      userInstruction: 'test region',
      config: { npcCount: 0, subLocationCount: 2, generateItems: true, itemCount: 2 },
    }, TEST_PATHS);

    const prompt = (calls[0].messages as Array<{ role: string; content: string }>)[1].content;
    expect(prompt).not.toContain('常驻 NPC');
    expect(prompt).not.toContain('$.社交.关系');
    expect(prompt).toContain('2 个特色物品');
    expect(prompt).toContain('$.角色.背包.物品');
  });

  it('generateItems=false → prompt omits item sections', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'region',
      userInstruction: 'test region',
      config: { npcCount: 3, subLocationCount: 2, generateItems: false },
    }, TEST_PATHS);

    const prompt = (calls[0].messages as Array<{ role: string; content: string }>)[1].content;
    expect(prompt).toContain('3 个常驻 NPC');
    expect(prompt).not.toContain('特色物品');
    expect(prompt).not.toContain('$.角色.背包.物品');
  });

  it('user instruction containing {{...}} markers is NOT expanded', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'region',
      userInstruction: '{{NPC_TASK_BULLETS}} test injection',
      config: { npcCount: 0, subLocationCount: 2, generateItems: false },
    }, TEST_PATHS);

    const prompt = (calls[0].messages as Array<{ role: string; content: string }>)[1].content;
    expect(prompt).toContain('{{NPC_TASK_BULLETS}} test injection');
    expect(prompt).not.toContain('常驻 NPC');
  });

  it('negative npcCount is clamped to 0 (NPC disabled)', async () => {
    const { svc, calls } = makeService(VALID_AI_RESPONSE);

    await svc.execute('default', {
      type: 'region',
      userInstruction: 'test',
      config: { npcCount: -3, subLocationCount: 2, generateItems: true, itemCount: 1 },
    }, TEST_PATHS);

    const prompt = (calls[0].messages as Array<{ role: string; content: string }>)[1].content;
    expect(prompt).not.toContain('常驻 NPC');
    expect(prompt).not.toContain('$.社交.关系');
  });
});

// Item 2 (PO 2026-10-05): the world builder reads its prompts as the prompt page left them, not the pack's text.
describe('WorldBuilderService — the prompt page reaches it', () => {
  it('sends the edited task prompt despite a stored off, and leaves out a jailbreak switched off', async () => {
    const registry = new PromptRegistry();
    registry.registerPack(PACK.prompts, isPromptAlwaysOn);
    registry.setUserContent('worldBuilderFromDescription', 'EDITED DESC {USER_INSTRUCTION}');
    registry.setEnabled('worldBuilderFromDescription', false);
    registry.setEnabled('assistantJailbreak', false);
    const sm = new FakeStateManager(JSON.parse(JSON.stringify(INITIAL_STATE)));
    const { aiService, calls } = makeAIService(VALID_AI_RESPONSE);
    const svc = new WorldBuilderService({
      aiService, stateManager: sm as unknown as StateManager, gamePack: PACK,
      payloadValidator: new PayloadValidator({ stateManager: sm as unknown as StateManager, gamePack: PACK }),
      conversationStore: new InMemoryConversationStore(),
      prompts: new PromptAssembler(registry, new TemplateEngine()),
    });
    await svc.execute('default', { type: 'from-description', userInstruction: '雪山' }, TEST_PATHS);
    const msgs = calls[0].messages as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'EDITED DESC 雪山' });
    expect(msgs.some((m) => m.content.includes('JAILBREAK_PROMPT'))).toBe(false);
  });
});
