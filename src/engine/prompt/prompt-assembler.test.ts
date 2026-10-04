import { describe, it, expect } from 'vitest';
import { PromptAssembler } from '@/engine/prompt/prompt-assembler';
import { TemplateEngine } from '@/engine/prompt/template-engine';
import { createMockPromptRegistry } from '@/engine/__test-utils__';
import type { PromptFlowConfig } from '@/engine/types';
import type { AIMessage } from '@/engine/ai/types';

function makeFlow(modules: PromptFlowConfig['modules']): PromptFlowConfig {
  return { id: 'test-flow', modules };
}

describe('PromptAssembler', () => {
  const template = new TemplateEngine();

  it('assembles a single system module', () => {
    const registry = createMockPromptRegistry([{ id: 'core', content: 'System prompt.' }]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([{ promptId: 'core', role: 'system', order: 0, depth: 0 }]);
    const result = assembler.assemble(flow, {});
    expect(result.messages).toHaveLength(2); // system + user placeholder (Gemini guard)
    expect(result.messages[0].content).toBe('System prompt.');
  });

  it('sorts modules by order', () => {
    const registry = createMockPromptRegistry([
      { id: 'a', content: 'A' },
      { id: 'b', content: 'B' },
      { id: 'c', content: 'C' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([
      { promptId: 'c', role: 'system', order: 3, depth: 0 },
      { promptId: 'a', role: 'system', order: 1, depth: 0 },
      { promptId: 'b', role: 'system', order: 2, depth: 0 },
    ]);
    const result = assembler.assemble(flow, {});
    expect(result.messages[0].content).toBe('A');
    expect(result.messages[1].content).toBe('B');
    expect(result.messages[2].content).toBe('C');
  });

  it('skips module when condition variable is falsy', () => {
    const registry = createMockPromptRegistry([
      { id: 'always', content: 'Always' },
      { id: 'conditional', content: 'Conditional' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([
      { promptId: 'always', role: 'system', order: 0, depth: 0 },
      { promptId: 'conditional', role: 'system', order: 1, depth: 0, condition: 'HAS_NPC' },
    ]);
    const result = assembler.assemble(flow, { HAS_NPC: '' });
    const contents = result.messages.map((m) => m.content);
    expect(contents).toContain('Always');
    expect(contents).not.toContain('Conditional');
  });

  it('includes module when condition variable is truthy', () => {
    const registry = createMockPromptRegistry([
      { id: 'conditional', content: 'Yes' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([
      { promptId: 'conditional', role: 'system', order: 0, depth: 0, condition: 'FLAG' },
    ]);
    const result = assembler.assemble(flow, { FLAG: '1' });
    expect(result.messages.some((m) => m.content === 'Yes')).toBe(true);
  });

  it('renders template variables', () => {
    const registry = createMockPromptRegistry([
      { id: 'tpl', content: 'Hello {{NAME}}, you are at {{LOCATION}}.' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([{ promptId: 'tpl', role: 'system', order: 0, depth: 0 }]);
    const result = assembler.assemble(flow, { NAME: 'Alice', LOCATION: 'S市' });
    expect(result.messages[0].content).toBe('Hello Alice, you are at S市.');
  });

  it('skips disabled/missing modules', () => {
    const registry = createMockPromptRegistry([
      { id: 'enabled', content: 'Yes' },
      { id: 'disabled', content: 'No', enabled: false },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([
      { promptId: 'enabled', role: 'system', order: 0, depth: 0 },
      { promptId: 'disabled', role: 'system', order: 1, depth: 0 },
      { promptId: 'nonexistent', role: 'system', order: 2, depth: 0 },
    ]);
    const result = assembler.assemble(flow, {});
    expect(result.sections).toHaveLength(1);
  });

  it('injects depth>0 modules into chat history', () => {
    const registry = createMockPromptRegistry([
      { id: 'sys', content: 'System' },
      { id: 'deep', content: 'Injected' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([
      { promptId: 'sys', role: 'system', order: 0, depth: 0 },
      { promptId: 'deep', role: 'system', order: 1, depth: 1 },
    ]);
    const history: AIMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'World' },
    ];
    const result = assembler.assemble(flow, {}, history);
    // depth=1: insert 1 from end → before the last history message
    const contents = result.messages.map((m) => m.content);
    const deepIdx = contents.indexOf('Injected');
    const worldIdx = contents.indexOf('World');
    expect(deepIdx).toBeLessThan(worldIdx);
  });

  it('appends user placeholder when all messages are system role', () => {
    const registry = createMockPromptRegistry([
      { id: 'sys', content: 'System only' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([{ promptId: 'sys', role: 'system', order: 0, depth: 0 }]);
    const result = assembler.assemble(flow, {});
    const last = result.messages[result.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('请根据以上设定开始');
  });

  it('does NOT add placeholder when user message exists', () => {
    const registry = createMockPromptRegistry([
      { id: 'sys', content: 'System' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([{ promptId: 'sys', role: 'system', order: 0, depth: 0 }]);
    const history: AIMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = assembler.assemble(flow, {}, history);
    const userMsgs = result.messages.filter((m) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
    expect(userMsgs[0].content).toBe('Hi');
  });

  it('renderSingle returns rendered content', () => {
    const registry = createMockPromptRegistry([
      { id: 'test', content: 'Hello {{X}}' },
    ]);
    const assembler = new PromptAssembler(registry as never, template);
    expect(assembler.renderSingle('test', { X: 'World' })).toBe('Hello World');
  });

  it('renderSingle returns null for unknown ID', () => {
    const registry = createMockPromptRegistry([]);
    const assembler = new PromptAssembler(registry as never, template);
    expect(assembler.renderSingle('unknown', {})).toBeNull();
  });

  it('handles flow with empty modules array', () => {
    const registry = createMockPromptRegistry([]);
    const assembler = new PromptAssembler(registry as never, template);
    const flow = makeFlow([]);
    const result = assembler.assemble(flow, {});
    expect(result.messages).toHaveLength(0);
    expect(result.sections).toHaveLength(0);
    expect(result.messageSources).toHaveLength(0);
  });

  // ─── 2026-04-14 messageSources parallel array ───────────────

  describe('messageSources (2026-04-14)', () => {
    it('parallel-tags each depth=0 module message with module:<id>', () => {
      const registry = createMockPromptRegistry([
        { id: 'mainRound', content: 'Main' },
        { id: 'core', content: 'Core' },
      ]);
      const assembler = new PromptAssembler(registry as never, template);
      const flow = makeFlow([
        { promptId: 'mainRound', role: 'system', order: 0, depth: 0 },
        { promptId: 'core', role: 'system', order: 1, depth: 0 },
      ]);
      const result = assembler.assemble(flow, {});
      expect(result.messageSources.length).toBe(result.messages.length);
      expect(result.messageSources[0]).toBe('module:mainRound');
      expect(result.messageSources[1]).toBe('module:core');
    });

    it('tags chatHistory entries with history:user / history:assistant', () => {
      const registry = createMockPromptRegistry([{ id: 'sys', content: 'S' }]);
      const assembler = new PromptAssembler(registry as never, template);
      const flow = makeFlow([{ promptId: 'sys', role: 'system', order: 0, depth: 0 }]);
      const chat: AIMessage[] = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
      ];
      const result = assembler.assemble(flow, {}, chat);
      expect(result.messageSources).toEqual([
        'module:sys',
        'history:user',
        'history:assistant',
        'history:user',
      ]);
    });

    it('tags depth>0 injection messages with module:<id> at correct spliced index', () => {
      const registry = createMockPromptRegistry([
        { id: 'sys', content: 'S' },
        { id: 'inj', content: 'I' },
      ]);
      const assembler = new PromptAssembler(registry as never, template);
      const flow = makeFlow([
        { promptId: 'sys', role: 'system', order: 0, depth: 0 },
        { promptId: 'inj', role: 'system', order: 1, depth: 1 },
      ]);
      const chat: AIMessage[] = [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
      ];
      const result = assembler.assemble(flow, {}, chat);
      // messages: [sys, user, inj-spliced-before-last, assistant]
      expect(result.messages.map((m) => m.content)).toEqual(['S', 'u1', 'I', 'a1']);
      // sources must mirror message ordering
      expect(result.messageSources).toEqual([
        'module:sys',
        'history:user',
        'module:inj',
        'history:assistant',
      ]);
    });

    it('tags Gemini placeholder as "placeholder"', () => {
      const registry = createMockPromptRegistry([{ id: 'sys', content: 'S' }]);
      const assembler = new PromptAssembler(registry as never, template);
      const flow = makeFlow([{ promptId: 'sys', role: 'system', order: 0, depth: 0 }]);
      const result = assembler.assemble(flow, {});
      // 2 messages: system + placeholder
      expect(result.messages).toHaveLength(2);
      expect(result.messageSources).toEqual(['module:sys', 'placeholder']);
    });
  });
});

// P7 (PO 2026-10-04): the story request's builder reads the prompt page through this view.
describe('PromptAssembler.effectivePrompts', () => {
  it("gives the edited text, '' for a prompt switched off, the text of a required one anyway, the pack's for one the registry does not know", () => {
    const registry = createMockPromptRegistry([
      { id: 'edited', content: 'EDITED' },
      { id: 'off', content: 'OFF', enabled: false },
      { id: 'format', content: 'FORMAT', enabled: false },
    ]);
    const assembler = new PromptAssembler(registry as never, new TemplateEngine());
    const out = assembler.effectivePrompts({ edited: 'pack edited', off: 'pack off', format: 'pack format', unknown: 'pack unknown' }, new Set(['format']));
    expect(out).toEqual({ edited: 'EDITED', off: '', format: 'FORMAT', unknown: 'pack unknown' });
  });
});
