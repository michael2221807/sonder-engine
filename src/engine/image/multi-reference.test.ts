import { describe, it, expect } from 'vitest';
import { clampReferencesForBackend, PROVIDER_CAPABILITIES } from './provider-capabilities';

/**
 * 多图参考重绘 · 后端能力收敛（epic S2，2026-08-29）。
 *
 * PO 决策① ：只有豆包 Seedream 支持多参考图；NovelAI / Civitai 的多图属于
 * 语义不同的另一功能，不并入。UI 按 `multiReference` 决定要不要给多选，
 * 编排层用本函数兜底——两层用同一个能力位，避免上次 seed 那种「上游封死导致
 * 下游门控成死代码」的反向缺陷。
 */
describe('clampReferencesForBackend', () => {
  const refs = (n: number) => Array.from({ length: n }, (_, i) => `img${i}`);

  it('豆包：多图原样放行，顺序不变（顺序=提示词里的「图N」）', () => {
    const r = clampReferencesForBackend('volcengine', refs(5));
    expect(r.effective).toEqual(['img0', 'img1', 'img2', 'img3', 'img4']);
    expect(r.dropped).toBe(0);
  });

  it('NovelAI / Civitai：收敛到第 1 张并报告丢弃数（调用方据此告警）', () => {
    for (const backend of ['novelai', 'civitai'] as const) {
      const r = clampReferencesForBackend(backend, refs(4));
      expect(r.effective).toEqual(['img0']);
      expect(r.dropped).toBe(3);
    }
  });

  it('单张 / 空列表：任何后端都原样通过，不报丢弃', () => {
    for (const backend of ['volcengine', 'novelai', 'civitai'] as const) {
      expect(clampReferencesForBackend(backend, refs(1))).toEqual({ effective: ['img0'], dropped: 0 });
      expect(clampReferencesForBackend(backend, [])).toEqual({ effective: [], dropped: 0 });
    }
  });

  it('返回的是副本，不会把调用方的数组改掉', () => {
    const input = refs(3);
    const r = clampReferencesForBackend('volcengine', input);
    r.effective.push('mutated');
    expect(input).toHaveLength(3);
  });

  it('能力位与收敛行为始终一致（新增后端不会漏配）', () => {
    for (const [backend, caps] of Object.entries(PROVIDER_CAPABILITIES)) {
      const { dropped } = clampReferencesForBackend(backend as keyof typeof PROVIDER_CAPABILITIES, refs(3));
      expect(dropped === 0).toBe(caps.multiReference === true);
    }
  });
});
