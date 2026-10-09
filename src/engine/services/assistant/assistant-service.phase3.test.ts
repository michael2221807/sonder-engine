/**
 * AssistantService Phase 3 测试 —— applyPayload + rollbackLastInject
 *
 * 覆盖：
 * - applyPayload 拒绝 error draft / 非 pending draft
 * - applyPayload 成功 → 状态更新 + draft.injected + 快照保存 + audit + system 消息
 * - applyPayload 失败（CommandExecutor hasErrors）→ 自动 rollback + 清空快照 + system 消息
 * - rollbackLastInject 无快照 → ok=false
 * - rollbackLastInject 成功 → 状态恢复 + 快照清空 + draft.rolledBackAt + system 消息
 * - 单步快照：连续两次注入只能 undo 最后一次
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AssistantService } from './assistant-service';
import { InMemoryConversationStore } from './conversation-store';
import type { CommandExecutor } from '../../core/command-executor';
import type { StateManager } from '../../core/state-manager';
import { RollbackSnapshot } from '../../core/rollback-snapshot';
import { DEFAULT_ENGINE_PATHS } from '../../pipeline/types';
import type { GamePack } from '../../types';
import type { AIService } from '../../ai/ai-service';
import type { PayloadDraft, ValidatedPatch, AssistantMessage } from './types';
import { generateAssistantMessageId } from './types';

/** 内存状态树 mock —— 实现 toSnapshot/rollbackTo + get */
class MockStateManager {
  state: Record<string, unknown>;
  constructor(initial: Record<string, unknown> = {}) { this.state = JSON.parse(JSON.stringify(initial)); }
  get<T>(path: string): T | undefined {
    const segs = path.split('.').filter(Boolean);
    let cur: unknown = this.state;
    for (const s of segs) {
      if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[s];
      else return undefined;
    }
    return cur as T;
  }
  toSnapshot(): Record<string, unknown> { return JSON.parse(JSON.stringify(this.state)); }
  rollbackTo(snapshot: Record<string, unknown>): void {
    this.state = JSON.parse(JSON.stringify(snapshot));
  }
}

/** Mock CommandExecutor：可配置成功/失败 + 实际 mutate state */
class MockCommandExecutor {
  shouldFail = false;
  callCount = 0;
  constructor(private sm: MockStateManager) {}
  executeBatch(commands: Array<{ action: string; key: string; value?: unknown }>) {
    this.callCount++;
    if (this.shouldFail) {
      return {
        results: commands.map((c) => ({ success: false, command: c, error: 'forced fail' })),
        changeLog: { changes: [], source: 'command', timestamp: 0 },
        hasErrors: true,
      };
    }
    // 实际应用 commands
    for (const cmd of commands) {
      const segs = cmd.key.split('.');
      let cur: Record<string, unknown> = this.sm.state;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (!cur[s] || typeof cur[s] !== 'object') cur[s] = {};
        cur = cur[s] as Record<string, unknown>;
      }
      const last = segs[segs.length - 1];
      if (cmd.action === 'set') cur[last] = cmd.value;
      else if (cmd.action === 'push') {
        if (!Array.isArray(cur[last])) cur[last] = [];
        (cur[last] as unknown[]).push(cmd.value);
      }
      else if (cmd.action === 'pull') {
        if (Array.isArray(cur[last])) {
          const arr = cur[last] as unknown[];
          const valJson = JSON.stringify(cmd.value);
          const idx = arr.findIndex((x) => JSON.stringify(x) === valJson);
          if (idx >= 0) arr.splice(idx, 1);
        }
      }
    }
    return {
      results: commands.map((c) => ({ success: true, command: c })),
      changeLog: { changes: [], source: 'command', timestamp: 0 },
      hasErrors: false,
    };
  }
}

function makeService(initial: Record<string, unknown> = {}) {
  const sm = new MockStateManager(initial);
  const exec = new MockCommandExecutor(sm);
  const svc = new AssistantService({
    aiService: { async generate() { return ''; } } as unknown as AIService,
    stateManager: sm as unknown as StateManager,
    commandExecutor: exec as unknown as CommandExecutor,
    gamePack: { prompts: {} } as unknown as GamePack,
    conversationStore: new InMemoryConversationStore(),
  });
  return { svc, sm, exec };
}

function okPatch(p: { target: string; op: string; value?: unknown; match?: { by: string; value: unknown } }): ValidatedPatch {
  return { ...p, status: 'ok', issues: [] } as ValidatedPatch;
}

function errPatch(p: { target: string; op: string; value?: unknown }): ValidatedPatch {
  return { ...p, status: 'error', issues: ['mock error'] } as ValidatedPatch;
}

function makeDraft(validated: ValidatedPatch[]): PayloadDraft {
  return {
    raw: { summary: '', patches: validated.map(({ status, issues, ...rest }) => { void status; void issues; return rest; }) },
    validated,
    status: 'pending',
  };
}

// ─── applyPayload ─────────────────────────────────────────

describe('applyPayload — 校验阻断', () => {
  it('有 error 的 draft 拒绝注入', async () => {
    const { svc } = makeService();
    const draft = makeDraft([errPatch({ target: 'X', op: 'set-field', value: 1 })]);
    const result = await svc.applyPayload('default', 'msg-1', draft);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('error');
    expect(svc.canRollbackInject()).toBe(false); // 没有快照
  });

  it('已 injected 的 draft 拒绝二次注入', async () => {
    const { svc } = makeService({ 角色: { 姓名: 'X' } });
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: 'Y' })]);
    await svc.applyPayload('default', 'msg-1', draft);
    expect(draft.status).toBe('injected');
    const second = await svc.applyPayload('default', 'msg-2', draft);
    expect(second.ok).toBe(false);
  });
});

describe('applyPayload — 成功路径', () => {
  let test: ReturnType<typeof makeService>;
  beforeEach(() => { test = makeService({ 角色: { 姓名: '李白' } }); });

  it('成功注入 → state 更新 + draft.injected + canRollback=true', async () => {
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: '苏墨' })]);
    const result = await test.svc.applyPayload('default', 'msg-1', draft);
    expect(result.ok).toBe(true);
    expect(result.patchCount).toBe(1);
    expect(test.sm.state.角色).toEqual({ 姓名: '苏墨' });
    expect(draft.status).toBe('injected');
    expect(draft.injectedAt).toBeDefined();
    expect(test.svc.canRollbackInject()).toBe(true);
  });

  it('注入后 conversation 末尾追加 inject-success 系统消息', async () => {
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: 'X' })]);
    await test.svc.applyPayload('default', 'msg-1', draft);
    const session = await test.svc.getSession('default');
    const last = session.messages[session.messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.systemKind).toBe('inject-success');
  });

  it('audit log 累加', async () => {
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: 'X' })]);
    await test.svc.applyPayload('default', 'msg-1', draft);
    const log = test.svc._testGetAuditLog();
    expect(log).toHaveLength(1);
    expect(log[0].patchCount).toBeGreaterThan(0);
  });
});

describe('applyPayload — 失败路径 + 自动 rollback', () => {
  it('CommandExecutor 失败 → state 回到注入前 + 系统消息 + 不缓存快照', async () => {
    const test = makeService({ 角色: { 姓名: '李白' } });
    test.exec.shouldFail = true;
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: '苏墨' })]);
    const result = await test.svc.applyPayload('default', 'msg-1', draft);
    expect(result.ok).toBe(false);
    // state 回到了注入前
    expect((test.sm.state.角色 as Record<string, unknown>).姓名).toBe('李白');
    // 不能 undo（避免 stale 快照被使用）
    expect(test.svc.canRollbackInject()).toBe(false);
    // 系统消息
    const session = await test.svc.getSession('default');
    const last = session.messages[session.messages.length - 1];
    expect(last.systemKind).toBe('inject-failed');
  });
});

// ─── rollbackLastInject ───────────────────────────────────

describe('rollbackLastInject', () => {
  it('无快照时 ok=false', async () => {
    const { svc } = makeService();
    const result = await svc.rollbackLastInject('default');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('没有可撤销');
  });

  it('成功 inject 后撤销 → state 恢复 + 快照清空 + 系统消息', async () => {
    const test = makeService({ 角色: { 姓名: '李白' } });
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: '苏墨' })]);
    await test.svc.applyPayload('default', 'msg-1', draft);
    expect((test.sm.state.角色 as Record<string, unknown>).姓名).toBe('苏墨');

    const result = await test.svc.rollbackLastInject('default');
    expect(result.ok).toBe(true);
    expect((test.sm.state.角色 as Record<string, unknown>).姓名).toBe('李白');
    expect(test.svc.canRollbackInject()).toBe(false); // 单步快照已清

    const session = await test.svc.getSession('default');
    const last = session.messages[session.messages.length - 1];
    expect(last.systemKind).toBe('inject-rolled-back');
  });

  it('撤销时主回合的回退快照随注入前的树一起回来（存档瘦身 D1A：即使中间又玩了几回合）', async () => {
    const holder = new RollbackSnapshot(DEFAULT_ENGINE_PATHS);
    const sm = new MockStateManager({ 元数据: { 回合序号: 10 }, 角色: { 姓名: '李白' } });
    const marker = holder.capture({ 元数据: { 回合序号: 9 } });
    sm.state.系统 = { 扩展: { rollbackPatch: marker } };
    const svc = new AssistantService({
      aiService: { async generate() { return ''; } } as unknown as AIService,
      stateManager: sm as unknown as StateManager,
      commandExecutor: new MockCommandExecutor(sm) as unknown as CommandExecutor,
      gamePack: { prompts: {} } as unknown as GamePack,
      conversationStore: new InMemoryConversationStore(),
      rollbackSnapshot: holder,
    });
    await svc.applyPayload('default', 'm1', makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: '苏墨' })]));
    // Rounds go on: each round start replaces what the holder holds.
    holder.capture({ 元数据: { 回合序号: 13 } });
    expect(holder.get(marker)).toBeUndefined();

    expect((await svc.rollbackLastInject('default')).ok).toBe(true);
    expect(sm.get(DEFAULT_ENGINE_PATHS.rollbackPatch)).toBe(marker);
    expect(holder.get(marker)).toEqual({ 元数据: { 回合序号: 9 } });
  });

  it('单步：连续两次 inject 只能 undo 最后一次', async () => {
    const test = makeService({ counter: { v: 0 } });
    await test.svc.applyPayload('default', 'm1', makeDraft([
      okPatch({ target: 'counter.v', op: 'set-field', value: 1 }),
    ]));
    await test.svc.applyPayload('default', 'm2', makeDraft([
      okPatch({ target: 'counter.v', op: 'set-field', value: 2 }),
    ]));
    expect((test.sm.state.counter as Record<string, unknown>).v).toBe(2);

    await test.svc.rollbackLastInject('default'); // undo to v=1（第二次注入前）
    expect((test.sm.state.counter as Record<string, unknown>).v).toBe(1);

    // 不能再 undo
    const second = await test.svc.rollbackLastInject('default');
    expect(second.ok).toBe(false);
  });

  it('rollback 后在对应 message 上标 rolledBackAt', async () => {
    const test = makeService({ 角色: { 姓名: 'X' } });
    // 先手工 push 一条带 payloadDraft 的 assistant message
    const session = await test.svc.getSession('default');
    const draft = makeDraft([okPatch({ target: '角色.姓名', op: 'set-field', value: 'Y' })]);
    const msg: AssistantMessage = {
      id: generateAssistantMessageId(),
      role: 'assistant',
      content: 'mock',
      timestamp: Date.now(),
      payloadDraft: draft,
    };
    session.messages.push(msg);
    await new InMemoryConversationStore().save(session); // 仅保留消息引用以便后续查找
    // 重新走 store 路径
    const store = new InMemoryConversationStore();
    await store.save(session);
    const test2 = (() => {
      const sm = new MockStateManager({ 角色: { 姓名: 'X' } });
      const exec = new MockCommandExecutor(sm);
      const svc = new AssistantService({
        aiService: { async generate() { return ''; } } as unknown as AIService,
        stateManager: sm as unknown as StateManager,
        commandExecutor: exec as unknown as CommandExecutor,
        gamePack: { prompts: {} } as unknown as GamePack,
        conversationStore: store,
      });
      return { svc, sm, exec };
    })();

    await test2.svc.applyPayload('default', msg.id, draft);
    await test2.svc.rollbackLastInject('default');

    const after = await test2.svc.getSession('default');
    const matched = after.messages.find((m) => m.id === msg.id);
    expect(matched?.payloadDraft?.rolledBackAt).toBeDefined();
  });
});
