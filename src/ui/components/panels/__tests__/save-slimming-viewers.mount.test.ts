// @vitest-environment happy-dom
/**
 * The two per-round viewers with the slimmed save data (存档瘦身 P1 B4):
 * - DeltaViewer: a push or pull stored with its one entry (D3A) shows that entry — the added one, or the removed one
 *   struck through; a record still holding both lists shows as before.
 * - EngramRoundViewer: a retrieval trace of an earlier round keeps only its injected memories (D2B); the filtered
 *   ones show as counts by outcome; a whole trace shows as before.
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import DeltaViewer from '@/ui/components/shared/DeltaViewer.vue';
import EngramRoundViewer from '@/ui/components/panels/engram/EngramRoundViewer.vue';
import { i18n } from '@/ui/i18n';
import type { EngramReadSnapshot } from '@/engine/memory/engram/engram-types';

describe('DeltaViewer with records stored compactly (存档瘦身 D3A)', () => {
  const mountWith = (changes: unknown[]) => mount(DeltaViewer, { props: { changes: changes as never }, global: { plugins: [i18n] } });

  it('shows the entry a push added and the entry a pull removed', () => {
    const wrapper = mountWith([
      { path: '社交.事件.事件记录', action: 'push', element: { 事件名称: '集市相遇' }, timestamp: 1, source: 'main' },
      { path: '角色.效果', action: 'pull', element: '疲惫', index: 1, timestamp: 2, source: 'main' },
    ]);
    const rows = wrapper.findAll('[data-testid="delta-entry"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].find('.delta-new').text()).toBe('{"事件名称":"集市相遇"}');
    expect(rows[1].find('.delta-old').text()).toBe('疲惫');
    expect(wrapper.find('.delta-arrow').exists()).toBe(false);
  });

  it('gives an entry the whole row: a long one is no longer cut at 60 characters', () => {
    const element = { 事件名称: '到了集市', 事件描述: '主角在集市口遇到了卖花的老人，老人说起二十年前那场大火，还提到了城东的旧宅和一个名字。' };
    const wrapper = mountWith([{ path: '社交.事件.事件记录', action: 'push', element, timestamp: 1, source: 'main' }]);
    const entry = wrapper.find('[data-testid="delta-entry"] .delta-new');
    expect(entry.classes()).toContain('delta-entry');
    expect(entry.text()).toBe(JSON.stringify(element));
    expect(JSON.stringify(element).length).toBeGreaterThan(60);
  });

  it('takes a record that kept its lists for one of the old kind, even with an element field', () => {
    const wrapper = mountWith([
      { path: '社交.事件.事件记录', action: 'push', oldValue: [], newValue: [{ n: 1 }], element: { n: 1 }, timestamp: 1 },
    ]);
    expect(wrapper.find('[data-testid="delta-entry"]').exists()).toBe(false);
    expect(wrapper.find('.delta-values .delta-new').text()).toBe('[{"n":1}]');
  });

  it('shows a record that still holds both lists as before', () => {
    const wrapper = mountWith([
      { path: '社交.事件.事件记录', action: 'push', oldValue: [{ n: 1 }], newValue: [{ n: 1 }, { n: 2 }], timestamp: 1 },
      { path: '角色.姓名', action: 'set', oldValue: '甲', newValue: '乙', timestamp: 2 },
    ]);
    expect(wrapper.find('[data-testid="delta-entry"]').exists()).toBe(false);
    const values = wrapper.findAll('.delta-values');
    expect(values[0].find('.delta-new').text()).toBe('[{"n":1},{"n":2}]');
    expect(values[1].text()).toContain('甲');
    expect(values[1].find('.delta-new').text()).toBe('乙');
  });
});

describe('EngramRoundViewer with a trimmed trace (存档瘦身 D2B)', () => {
  const read = (overrides: Partial<EngramReadSnapshot>): EngramReadSnapshot => ({
    query: '问',
    capturedAt: 0,
    totalDurationMs: 12,
    candidates: [],
    pipeline: { vectorEventCount: 3, vectorEntityCount: 1, graphCount: 0, afterMerge: 4, afterRerank: 4, injectedCount: 1 },
    config: {
      minScore: 0.3, topK: 5, rerankEnabled: false, rerankTopN: 0, embeddingEnabled: true, shortTermWindow: 3,
      maxCandidates: 20, edgeBudget: 5, entityBudget: 5, eventBudget: 5,
    },
    ...overrides,
  });
  const candidate = (text: string, outcome: string) => ({
    text, outcome, source: 'event', finalScore: 0.5, components: [],
  });
  const mountWith = (trace: EngramReadSnapshot) => mount(EngramRoundViewer, {
    props: { modelValue: true, read: trace, roundNumber: 3 },
    global: { plugins: [i18n], stubs: { Teleport: true } },
  });

  it('shows the filtered candidates of a trimmed trace as counts by outcome', () => {
    const wrapper = mountWith(read({
      candidates: [candidate('用上的记忆', 'injected')] as never,
      trimmed: { counts: { injected: 1, 'filtered-by-topK': 8, 'filtered-as-redundant': 2 } },
    }));
    const trimmed = wrapper.find('[data-testid="engram-trimmed"]');
    expect(trimmed.exists()).toBe(true);
    expect(trimmed.text()).toContain('被淘汰 10 条');
    expect(trimmed.text()).toContain('topK 截断 8');
    expect(trimmed.text()).toContain('去重淘汰 2');
    expect(wrapper.text()).toContain('用上的记忆');
    expect(wrapper.find('.erv__filtered-toggle').exists()).toBe(false);
  });

  it('shows a whole trace as before: the filtered list behind its toggle, no counts', () => {
    const wrapper = mountWith(read({
      candidates: [candidate('用上的记忆', 'injected'), candidate('落选的记忆', 'filtered-by-topK')] as never,
    }));
    expect(wrapper.find('[data-testid="engram-trimmed"]').exists()).toBe(false);
    expect(wrapper.find('.erv__filtered-toggle').text()).toContain('被淘汰 (1)');
  });
});
