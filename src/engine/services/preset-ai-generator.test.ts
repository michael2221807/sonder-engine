/**
 * PresetAIGenerator 单元测试
 *
 * 覆盖范围：
 * - parsePresetResponse：markdown 围栏剥离 / 多块选择 / CoT-then-final 退化案例
 * - validateRequired：必填字段缺失/空字符串
 * - pickSchemaFields：number 类型规范化（含 NaN→0 缺陷的回归测试）
 * - generate()：
 *   - jailbreak 注入（gamePack.prompts['narratorEnforcement']）
 *   - usageType: 'main' 路由
 *   - 用户 seed 为空时降级到默认 user message
 *   - aiService 抛错的处理
 *   - 空响应的处理
 *
 * 对应 cr-custom-presets-2026-04-14.md P1-2/P1-3 的回归基线。
 *
 * 注意：parsePresetResponse / validateRequired / pickSchemaFields 是模块内 private 函数，
 * 通过 generate() 间接覆盖（mock aiService 控制 raw response 来观察解析行为）。
 */
import { describe, it, expect, vi } from 'vitest';
import { PresetAIGenerator } from './preset-ai-generator';
import type { AIService } from '../ai/ai-service';
import type { GamePack, CustomPresetSchema } from '../types';

// ─── 测试辅助 ───────────────────────────────────────────────

const SCHEMA_BASIC: CustomPresetSchema = {
  fields: [
    { key: 'name', label: '名称', type: 'text', required: true },
    { key: 'description', label: '描述', type: 'textarea', required: true },
    { key: 'talent_cost', label: '天资花费', type: 'number', required: false, min: 0, max: 50 },
  ],
};

const SCHEMA_METADATA: CustomPresetSchema = {
  fields: [
    { key: 'genres', label: '适用题材', type: 'select', required: true, options: ['all', 'modern', 'wuxia'] },
    { key: 'adultOnly', label: '仅成人内容', type: 'checkbox', required: true },
  ],
};

/**
 * 创建一个返回固定字符串的 mock AIService
 *
 * 同时记录调用入参，方便断言 jailbreak 注入、usageType 等行为。
 */
function makeMockAIService(rawResponse: string | (() => string | Promise<string>)) {
  const calls: Array<{ messages: unknown; usageType: unknown; stream: unknown }> = [];
  const aiService = {
    async generate(options: { messages: unknown; usageType?: string; stream?: boolean }): Promise<string> {
      calls.push({ messages: options.messages, usageType: options.usageType, stream: options.stream });
      const r = typeof rawResponse === 'function' ? await rawResponse() : rawResponse;
      return r;
    },
  } as unknown as AIService;
  return { aiService, calls };
}

function makeGamePack(narratorEnforcement?: string): GamePack {
  return {
    prompts: narratorEnforcement
      ? { narratorEnforcement }
      : {},
    // 其余字段对本测试无关 —— 用 unknown cast 让 TS 通过
  } as unknown as GamePack;
}

// ─── parsePresetResponse 经由 generate() 的间接覆盖 ───────

describe('PresetAIGenerator.generate — JSON 解析', () => {
  it('解析裸 JSON 对象', async () => {
    const { aiService } = makeMockAIService(
      '{"name": "九霄界", "description": "一个修真世界", "talent_cost": 5}',
    );
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds',
      stepLabel: '世界',
      schema: SCHEMA_BASIC,
      userSeed: '修真',
    });
    expect(res.fields.name).toBe('九霄界');
    expect(res.fields.description).toBe('一个修真世界');
    expect(res.fields.talent_cost).toBe(5);
  });

  it('剥离 ```json ... ``` 围栏后解析', async () => {
    const { aiService } = makeMockAIService(
      '好的，下面是结果：\n```json\n{"name":"末世","description":"灰烬之地","talent_cost":3}\n```\n以上。',
    );
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('末世');
  });

  it('剥离 <thinking> 块后从最终答案中提取（CR P1-2 修复）', async () => {
    // CR P1-2：thinking 标签被剥离，最终答案中的 JSON 才会被选中
    const raw = `<thinking>
{"name": "草稿A", "description": "未定稿"}
</thinking>
{"name": "正式B", "description": "最终版", "talent_cost": 7}`;
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('正式B');
    expect(res.fields.talent_cost).toBe(7);
  });

  it('多个并列 JSON 块时选必填命中最多的（同分取最末）', async () => {
    // 第一块只有 name，第二块同时有 name+description（必填全），应选第二块
    const raw = `{"name":"半成品"}

{"name":"完整版","description":"全部必填齐"}`;
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('完整版');
  });

  it('多个等价 block 时取最末（最终答案在后的约定）', async () => {
    const raw = `{"name":"早","description":"D1"}

{"name":"晚","description":"D2"}`;
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('晚');
  });

  it('跳过非 JSON 文本，找到合法 JSON 块', async () => {
    const raw = `这是一段说明...

接下来是结果：

{"name":"宫廷世界","description":"步步惊心"}`;
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('宫廷世界');
  });

  it('完全无 JSON 时抛错', async () => {
    const { aiService } = makeMockAIService('我无法生成，请重试。');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/无法解析为 JSON/);
  });

  it('JSON 中嵌套字符串里含 { } 不会破坏平衡扫描', async () => {
    const raw = '{"name":"测试","description":"内含 { 和 } 字符的描述"}';
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.description).toBe('内含 { 和 } 字符的描述');
  });

  it('数组形式响应被拒绝，落到下一块', async () => {
    // 第一块是数组（非 object），第二块才是符合的对象
    const raw = '[1,2,3] 然后是： {"name":"X","description":"Y"}';
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('X');
  });
});

// ─── validateRequired 经由 generate() 的间接覆盖 ──────────

describe('PresetAIGenerator.generate — 必填校验', () => {
  it('缺必填 name 时抛错并提示中文 label', async () => {
    const { aiService } = makeMockAIService('{"description": "孤零零的描述"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/缺失必填字段.*名称/);
  });

  it('必填字段为空白字符串等同缺失', async () => {
    const { aiService } = makeMockAIService('{"name": "   ", "description": "ok"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/名称/);
  });

  it('必填字段为 null / undefined 也被视为缺失', async () => {
    const { aiService } = makeMockAIService('{"name": null, "description": "ok"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/名称/);
  });

  it('非必填字段缺失时不抛错', async () => {
    const { aiService } = makeMockAIService('{"name":"A","description":"B"}');
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    // talent_cost 非必填，缺失时 picked 也无该字段
    expect(res.fields.talent_cost).toBeUndefined();
  });

  it('多个必填字段同时缺失时全部列出', async () => {
    const { aiService } = makeMockAIService('{"talent_cost": 5}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/名称.*描述|描述.*名称/);
  });
});

// ─── pickSchemaFields 经由 generate() 的间接覆盖 ──────────

describe('PresetAIGenerator.generate — 字段类型规范化', () => {
  it('select genres 规范化为单元素数组，checkbox 保持 boolean', async () => {
    const { aiService } = makeMockAIService('{"genres":"modern","adultOnly":true}');
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'origins', stepLabel: '出身', schema: SCHEMA_METADATA, userSeed: '',
    });
    expect(res.fields.genres).toEqual(['modern']);
    expect(res.fields.adultOnly).toBe(true);
  });

  it('拒绝 select 契约外值和非 boolean checkbox', async () => {
    const { aiService } = makeMockAIService('{"genres":"space","adultOnly":"yes"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(gen.generate({
      presetType: 'origins', stepLabel: '出身', schema: SCHEMA_METADATA, userSeed: '',
    })).rejects.toThrow(/字段类型\/取值无效/);
  });

  it('number 字段：字符串数字被转换', async () => {
    const { aiService } = makeMockAIService('{"name":"A","description":"B","talent_cost":"7"}');
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.talent_cost).toBe(7);
  });

  it('number 字段：非数字字符串抛错（CR P1-3 修复 —— 不再静默归 0）', async () => {
    const { aiService } = makeMockAIService('{"name":"A","description":"B","talent_cost":"中等"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/数值字段无法解析.*天资花费/);
  });

  it('number 字段：null 也抛错', async () => {
    const { aiService } = makeMockAIService('{"name":"A","description":"B","talent_cost":null}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/数值字段无法解析/);
  });

  it('number 字段：未提供（undefined）时跳过，不抛错', async () => {
    const { aiService } = makeMockAIService('{"name":"A","description":"B"}');
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.talent_cost).toBeUndefined();
  });

  it('text 字段：非字符串值被 String() 转换', async () => {
    const { aiService } = makeMockAIService('{"name":42,"description":"B"}');
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.name).toBe('42');
  });

  it('text 字段：null 被规范成空字符串（且因必填校验抛错）', async () => {
    // null → '' → trim 后为空 → required 校验失败
    const { aiService } = makeMockAIService('{"name":null,"description":"B"}');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow();
  });

  it('schema 外的额外 key 被丢弃', async () => {
    const { aiService } = makeMockAIService(
      '{"name":"A","description":"B","extra":"should be ignored","another":42}',
    );
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.fields.extra).toBeUndefined();
    expect(res.fields.another).toBeUndefined();
  });
});

// ─── jailbreak 注入 + AI 调用契约 ────────────────────────

describe('PresetAIGenerator.generate — AI 调用契约', () => {
  const VALID_JSON = '{"name":"X","description":"Y"}';

  it('优先注入 creationGenJailbreak 作为首条 system 消息（CR P1-1）', async () => {
    const dedicated = '【系统】专属创角 jailbreak';
    const fallback = '【系统】主回合 narratorEnforcement';
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const pack = {
      prompts: { creationGenJailbreak: dedicated, narratorEnforcement: fallback },
    } as unknown as GamePack;
    const gen = new PresetAIGenerator(aiService, pack);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '修真',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toBe(dedicated);
  });

  it('缺 creationGenJailbreak 时 fallback 到 narratorEnforcement', async () => {
    const jailbreak = '【系统】narratorEnforcement fallback';
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const pack = makeGamePack(jailbreak);
    const gen = new PresetAIGenerator(aiService, pack);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '修真',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(jailbreak);
  });

  it('gamePack 为 null 时不注入 jailbreak —— 第一条直接是任务 prompt', async () => {
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '修真',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe('system');
    // 任务 prompt 包含 stepLabel
    expect(messages[0].content).toContain('世界');
    expect(messages[0].content).toContain('worlds');
  });

  it('gamePack.prompts 不含 narratorEnforcement 时也不注入', async () => {
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const pack = makeGamePack();  // 空 prompts
    const gen = new PresetAIGenerator(aiService, pack);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    // 只有任务 system + user，共 2 条
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[1].role).toBe('user');
  });

  it('usageType 强制为 "main"（复用主游戏 API 配置）', async () => {
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(calls[0].usageType).toBe('main');
    expect(calls[0].stream).toBe(false);
  });

  it('用户 seed 非空 → user message 是 trimmed seed', async () => {
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '  我想要末世修真  ',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toBe('我想要末世修真');
  });

  it('用户 seed 为空字符串 → 降级为默认提示（让 AI 自由发挥）', async () => {
    const { aiService, calls } = makeMockAIService(VALID_JSON);
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '   ',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg?.content).toContain('请根据上面的设定');
    expect(userMsg?.content).toContain('世界');
  });

  it('aiService.generate 抛错时被包装为友好消息', async () => {
    const aiService = {
      async generate() { throw new Error('429 Too Many Requests'); },
    } as unknown as AIService;
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/AI 调用失败.*429/);
  });

  it('aiService 返回空字符串时抛错', async () => {
    const { aiService } = makeMockAIService('');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/空内容/);
  });

  it('aiService 返回纯空白字符时抛错', async () => {
    const { aiService } = makeMockAIService('   \n\t  ');
    const gen = new PresetAIGenerator(aiService, null);
    await expect(
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '' }),
    ).rejects.toThrow(/空内容/);
  });

  it('任务 prompt 包含 number 字段范围信息（min/max）', async () => {
    const { aiService, calls } = makeMockAIService(
      '{"name":"X","description":"Y","talent_cost":3}',
    );
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const taskPrompt = messages.find((m) => m.role === 'system' && m.content.includes('字段定义'))!;
    expect(taskPrompt.content).toContain('min=0');
    expect(taskPrompt.content).toContain('max=50');
    expect(taskPrompt.content).toContain('必填');
  });

  it('返回结构含 rawResponse 供调试', async () => {
    const raw = '{"name":"A","description":"B"}';
    const { aiService } = makeMockAIService(raw);
    const gen = new PresetAIGenerator(aiService, null);
    const res = await gen.generate({
      presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: '',
    });
    expect(res.rawResponse).toBe(raw);
  });

  it('不同 step 走相同 generate 路径（presetType + stepLabel 写进 task prompt）', async () => {
    const { aiService, calls } = makeMockAIService('{"name":"A","description":"B"}');
    const gen = new PresetAIGenerator(aiService, null);
    await gen.generate({
      presetType: 'origins', stepLabel: '出身', schema: SCHEMA_BASIC, userSeed: '',
    });
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    const taskPrompt = messages.find((m) => m.role === 'system' && m.content.includes('字段定义'))!;
    expect(taskPrompt.content).toContain('出身');
    expect(taskPrompt.content).toContain('origins');
  });
});

// ─── 防止内部抛 unhandled promise rejection 的烟雾测试 ────

describe('PresetAIGenerator 行为冒烟', () => {
  it('快速并发 3 次 generate 都能完成（无共享状态污染）', async () => {
    let counter = 0;
    const aiService = {
      async generate() {
        counter++;
        return `{"name":"N${counter}","description":"D${counter}"}`;
      },
    } as unknown as AIService;
    const gen = new PresetAIGenerator(aiService, null);
    const results = await Promise.all([
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: 'a' }),
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: 'b' }),
      gen.generate({ presetType: 'worlds', stepLabel: '世界', schema: SCHEMA_BASIC, userSeed: 'c' }),
    ]);
    const names = new Set(results.map((r) => r.fields.name));
    expect(names.size).toBe(3);
  });

  it('未使用的 vi mock placeholder（防止 lint 删 import）', () => {
    // vitest spy/mock 不在此文件用到 —— 但保留 import 让未来扩展更容易
    expect(typeof vi.fn).toBe('function');
  });
});
