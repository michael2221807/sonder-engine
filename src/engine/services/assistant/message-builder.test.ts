/**
 * MessageBuilder 单元测试
 *
 * 覆盖：
 * - jailbreak 注入（assistantJailbreak）
 * - injection contract 仅 Mode B 注入（含 target attachment）
 * - 历史消息渲染（user with attachment label-only / assistant 原文 / system synthetic）
 * - 当前 turn user message：含 attachment snapshot + schema fragment
 * - NSFW stripped 时附带提示
 * - 无 attachment / 无 history / 无 gamePack 等极端情况
 */
import { describe, it, expect } from 'vitest';
import { MessageBuilder } from './message-builder';
import type { AssistantMessage, AttachmentPayload } from './types';
import { generateAssistantMessageId } from './types';
import type { GamePack } from '../../types';

function makeMsg(role: AssistantMessage['role'], content: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: generateAssistantMessageId(),
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

function makeAttachment(scope: 'context' | 'target', label: string, snapshot: unknown, nsfwStripped = false): AttachmentPayload {
  return {
    path: '社交.关系',
    label,
    scope,
    itemCount: Array.isArray(snapshot) ? snapshot.length : undefined,
    snapshot,
    schemaFragment: { type: 'array', items: { type: 'object' } },
    nsfwStripped,
  };
}

const PACK = {
  prompts: {
    assistantJailbreak: '【jailbreak】不主动拒绝',
    assistantInjectionContract: '【contract】用 patches 协议',
  },
} as unknown as GamePack;

describe('MessageBuilder — jailbreak / contract 注入', () => {
  const builder = new MessageBuilder();

  it('注入 jailbreak 作为首条 system', () => {
    const msgs = builder.build({
      history: [], userPrompt: 'hi', attachments: [], gamePack: PACK,
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('jailbreak');
  });

  it('Mode A（无 target）→ 不注入 contract', () => {
    const msgs = builder.build({
      history: [], userPrompt: 'hi', attachments: [], gamePack: PACK,
    });
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(1); // 只有 jailbreak
  });

  it('Mode B（有 target）→ 注入 contract', () => {
    const msgs = builder.build({
      history: [],
      userPrompt: '改一下',
      attachments: [makeAttachment('target', '社交关系', [{ 名称: 'A' }])],
      gamePack: PACK,
    });
    const systemMsgs = msgs.filter((m) => m.role === 'system');
    expect(systemMsgs).toHaveLength(2);
    expect(systemMsgs[1].content).toContain('contract');
  });

  it('gamePack=null → 不注入 system prompt', () => {
    const msgs = builder.build({
      history: [], userPrompt: 'hi', attachments: [], gamePack: null,
    });
    // 只有当前 user
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });
});

describe('MessageBuilder — 历史渲染', () => {
  const builder = new MessageBuilder();

  it('user 历史消息含 attachment label 但不含 snapshot', () => {
    const history = [
      makeMsg('user', '上次问题', {
        attachments: [{ path: '社交.关系', label: '社交关系', scope: 'target', itemCount: 5 }],
      }),
      makeMsg('assistant', '上次回答'),
    ];
    const msgs = builder.build({ history, userPrompt: '继续', attachments: [], gamePack: null });
    // MessageBuilder 只产 string content；String() 仅为 AIMessage.content 联合类型收窄
    const histUser = msgs.find((m) => m.role === 'user' && String(m.content).includes('上次问题'));
    expect(histUser?.content).toContain('社交关系'); // label
    expect(histUser?.content).toContain('数据快照不再附上'); // 提示
  });

  it('assistant 历史原文保留（含 fenced JSON 也保留）', () => {
    const history = [
      makeMsg('assistant', 'X\n```json\n{"summary":"old"}\n```'),
    ];
    const msgs = builder.build({ history, userPrompt: 'q', attachments: [], gamePack: null });
    const histAsst = msgs.find((m) => m.role === 'assistant');
    expect(histAsst?.content).toContain('json');
  });

  it('inject-success synthetic 系统消息转为提示', () => {
    const history = [
      makeMsg('system', '✅ 已注入', { systemKind: 'inject-success' }),
    ];
    const msgs = builder.build({ history, userPrompt: 'q', attachments: [], gamePack: null });
    const sysHist = msgs.find((m) => m.role === 'system' && String(m.content).includes('成功注入'));
    expect(sysHist).toBeDefined();
  });

  it('inject-rolled-back synthetic 转为提示', () => {
    const history = [
      makeMsg('system', '↶ 已撤销', { systemKind: 'inject-rolled-back' }),
    ];
    const msgs = builder.build({ history, userPrompt: 'q', attachments: [], gamePack: null });
    const sysHist = msgs.find((m) => m.role === 'system' && String(m.content).includes('撤销'));
    expect(sysHist).toBeDefined();
  });

  it('cleared / ai-error 系统消息不发给 AI（无意义）', () => {
    const history = [
      makeMsg('system', '🗑 清空', { systemKind: 'cleared' }),
      makeMsg('system', '⚠ AI 错', { systemKind: 'ai-error' }),
    ];
    const msgs = builder.build({ history, userPrompt: 'q', attachments: [], gamePack: null });
    // 没有这两条
    expect(msgs.find((m) => String(m.content).includes('清空'))).toBeUndefined();
    expect(msgs.find((m) => String(m.content).includes('AI 错'))).toBeUndefined();
  });
});

describe('MessageBuilder — 当前 turn user 消息', () => {
  const builder = new MessageBuilder();

  it('无 attachment → 仅含 prompt 文本', () => {
    const msgs = builder.build({
      history: [], userPrompt: 'hello world', attachments: [], gamePack: null,
    });
    const user = msgs.find((m) => m.role === 'user');
    expect(user?.content).toBe('hello world');
  });

  it('context attachment 渲染在"参考"块', () => {
    const att = makeAttachment('context', '世界描述', '某修真世界');
    const msgs = builder.build({
      history: [], userPrompt: 'X', attachments: [att], gamePack: null,
    });
    const user = msgs[msgs.length - 1];
    expect(user.content).toContain('附件（参考');
    expect(user.content).toContain('世界描述');
    expect(user.content).toContain('某修真世界');
  });

  it('target attachment 渲染在"目标"块', () => {
    const att = makeAttachment('target', '社交关系', [{ 名称: '王五' }]);
    const msgs = builder.build({
      history: [], userPrompt: '改', attachments: [att], gamePack: null,
    });
    const user = msgs[msgs.length - 1];
    expect(user.content).toContain('附件（目标');
    expect(user.content).toContain('王五');
  });

  it('snapshot 序列化为格式化 JSON', () => {
    const att = makeAttachment('target', 'X', [{ 名称: 'A', 好感度: 50 }]);
    const msgs = builder.build({
      history: [], userPrompt: 'X', attachments: [att], gamePack: null,
    });
    const user = msgs[msgs.length - 1];
    expect(user.content).toContain('```json');
    expect(user.content).toContain('"好感度": 50');
  });

  it('nsfwStripped=true 时附带剥离提示', () => {
    const att = makeAttachment('target', 'X', null, true);
    const msgs = builder.build({
      history: [], userPrompt: 'X', attachments: [att], gamePack: null,
    });
    const user = msgs[msgs.length - 1];
    expect(user.content).toContain('NSFW');
    expect(user.content).toContain('剥离');
  });

  it('schemaFragment 含 properties 时输出字段契约', () => {
    const att: AttachmentPayload = {
      path: '社交.关系',
      label: 'X',
      scope: 'target',
      snapshot: [],
      nsfwStripped: false,
      schemaFragment: {
        type: 'array',
        items: {
          type: 'object',
          required: ['名称'],
          properties: {
            名称: { type: 'string' },
            好感度: { type: 'number', minimum: -100, maximum: 100 },
          },
        },
      },
    };
    const msgs = builder.build({
      history: [], userPrompt: 'X', attachments: [att], gamePack: null,
    });
    const content = msgs[msgs.length - 1].content;
    expect(content).toContain('字段契约');
    expect(content).toContain('好感度');
    expect(content).toContain('min=-100');
    expect(content).toContain('必填');
  });
});

describe('MessageBuilder — 整体顺序', () => {
  it('jailbreak → contract → history → 当前 user', () => {
    const builder = new MessageBuilder();
    const history = [makeMsg('user', 'hist-q'), makeMsg('assistant', 'hist-a')];
    const att = makeAttachment('target', 'X', []);
    const msgs = builder.build({ history, userPrompt: 'cur-q', attachments: [att], gamePack: PACK });

    // 0: jailbreak system
    // 1: contract system
    // 2: history user (hist-q)
    // 3: history assistant (hist-a)
    // 4: current user
    expect(msgs[0].role).toBe('system');
    expect(msgs[0].content).toContain('jailbreak');
    expect(msgs[1].role).toBe('system');
    expect(msgs[1].content).toContain('contract');
    expect(msgs[2].role).toBe('user');
    expect(msgs[2].content).toContain('hist-q');
    expect(msgs[3].role).toBe('assistant');
    expect(msgs[4].role).toBe('user');
    expect(msgs[4].content).toContain('cur-q');
  });
});
