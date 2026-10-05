/**
 * isValidCardBundleShape 单元测试 — Story 5 (P9, optional)
 *
 * 纯 shape 校验：正例 + 各必填字段缺失/类型错误的反例（导入端 Story 6 的第一道闸门）。
 */
import { describe, it, expect } from 'vitest';
import { isValidCardBundleShape } from './game-card-bundle.types';

function makeValid(): Record<string, unknown> {
  return {
    bundleType: 'card',
    version: 1,
    exportedAt: '2026-06-02T00:00:00Z',
    engineVersion: '0.1.0',
    cardMeta: { formatVersion: 1, title: '测试卡', packId: 'tianming' },
    protagonist: { mode: 'fixed' },
    stateTree: {},
    engram: { entities: [], knowledgeEdges: [] },
  };
}

describe('isValidCardBundleShape', () => {
  it('accepts a minimal valid card bundle', () => {
    expect(isValidCardBundleShape(makeValid())).toBe(true);
  });

  it('rejects null / non-object', () => {
    expect(isValidCardBundleShape(null)).toBe(false);
    expect(isValidCardBundleShape(undefined)).toBe(false);
    expect(isValidCardBundleShape('card')).toBe(false);
  });

  it('rejects a wrong bundleType (must be the literal "card")', () => {
    expect(isValidCardBundleShape({ ...makeValid(), bundleType: 'full' })).toBe(false);
  });

  it('rejects an empty / missing card title', () => {
    const blank = makeValid();
    (blank.cardMeta as Record<string, unknown>).title = '   ';
    expect(isValidCardBundleShape(blank)).toBe(false);

    const missing = makeValid();
    delete (missing.cardMeta as Record<string, unknown>).title;
    expect(isValidCardBundleShape(missing)).toBe(false);
  });

  it('rejects a missing formatVersion', () => {
    const b = makeValid();
    delete (b.cardMeta as Record<string, unknown>).formatVersion;
    expect(isValidCardBundleShape(b)).toBe(false);
  });

  it('rejects an invalid protagonist mode', () => {
    expect(isValidCardBundleShape({ ...makeValid(), protagonist: { mode: 'wandering' } })).toBe(false);
  });

  it('rejects a malformed engram block', () => {
    expect(isValidCardBundleShape({ ...makeValid(), engram: { entities: [] } })).toBe(false);
    expect(isValidCardBundleShape({ ...makeValid(), engram: { entities: {}, knowledgeEdges: [] } })).toBe(false);
  });

  it('rejects a missing stateTree', () => {
    const b = makeValid();
    delete b.stateTree;
    expect(isValidCardBundleShape(b)).toBe(false);
  });

  // Code review M3 (2026-10-04): the author's prompt edits, when carried, are a list; a single bad entry is skipped
  // when applied, a container that is no list means a damaged card.
  it('accepts carried prompt edits as a list of entries, and rejects a damaged container', () => {
    expect(isValidCardBundleShape({ ...makeValid(), promptEdits: { version: 1, packId: 'tianming', entries: [{ id: 'x', content: 'y' }] } })).toBe(true);
    expect(isValidCardBundleShape({ ...makeValid(), builtinPromptOverrides: { version: 1, exportedAt: 'x', entries: [] } })).toBe(true);
    expect(isValidCardBundleShape({ ...makeValid(), promptEdits: { entries: 'oops' } })).toBe(false);
    expect(isValidCardBundleShape({ ...makeValid(), promptEdits: null })).toBe(false);
    expect(isValidCardBundleShape({ ...makeValid(), builtinPromptOverrides: [] })).toBe(false);
  });
});
