import { describe, it, expect } from 'vitest';
import { SettingCaptureStage, matchEvidenceInSegments, classifyEvidenceFailure } from './setting-capture';
import type { SettingCaptureResult } from './setting-capture';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext } from '../types';
import type { StateManager } from '../../core/state-manager';
import type { RawSettingUpdate } from '../../ai/types';
import type { WorldBook } from '../../prompt/world-book';
import { CAPTURED_SETTINGS_BOOK_ID } from '../../prompt/world-book';
import { scanSettingTags } from '../../prompt/setting-tag-scanner';
import { MAX_ACTIVE_CAPTURED_ENTRIES } from '../../prompt/captured-entry-mutations';
import { createMockStateManager, type MockStateManager } from '../../__test-utils__';

const paths = DEFAULT_ENGINE_PATHS;
const open = '<设定>';
const close = '</设定>';

const labels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

function makeStage(sm: MockStateManager, enabled = true): SettingCaptureStage {
  return new SettingCaptureStage(sm as unknown as StateManager, paths, {
    isEnabled: () => enabled,
    getTagNames: () => ['设定', 'setting'],
    getLabels: () => labels,
  });
}

function makeCtx(over: {
  originalUserInput?: string;
  settingUpdates?: RawSettingUpdate[];
  capturedHits?: string[];
} = {}): PipelineContext {
  return {
    userInput: over.originalUserInput ?? '',
    originalUserInput: over.originalUserInput,
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 3,
    generationId: 'test-gen',
    meta: over.capturedHits ? { capturedHits: over.capturedHits } : {},
    parsedResponse: over.settingUpdates !== undefined
      ? { text: 'narrative', settingUpdates: over.settingUpdates }
      : { text: 'narrative' },
  } as PipelineContext;
}

const goodUpdate: RawSettingUpdate = {
  kind: 'character',
  statement: '林月从小怕水。',
  evidence: '林月从小怕水',
  anchors: ['林月', '怕水'],
  entities: ['林月'],
};

async function run(
  sm: MockStateManager,
  ctx: PipelineContext,
  enabled = true,
): Promise<SettingCaptureResult> {
  const out = await makeStage(sm, enabled).execute(ctx);
  return out.meta['settingCapture'] as SettingCaptureResult;
}

function slotBooks(sm: MockStateManager): WorldBook[] {
  return sm.get<WorldBook[]>(paths.slotWorldBooks) ?? [];
}

function capturedEntries(sm: MockStateManager) {
  return slotBooks(sm).find((b) => b.id === CAPTURED_SETTINGS_BOOK_ID)?.entries ?? [];
}

// ═══════════════════════════════════════════════════════════

describe('SettingCaptureStage — happy path', () => {
  it('writes an accepted setting into a slot-owned captured book', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 3 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `我带她去码头。${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }));

    expect(r.accepted).toHaveLength(1);
    expect(r.rejected).toHaveLength(0);
    expect(r.noops).toHaveLength(0);
    expect(r.hadTag).toBe(true);

    const book = slotBooks(sm)[0];
    expect(book.id).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(book.ownership).toBe('slot');
    expect(book.origin).toBe('system-captured');
    expect(book.entries[0].content).toBe('林月从小怕水。');
    expect(book.entries[0].capturedSetting?.capturedRound).toBe(3);
  });

  it('one tag can yield several settings', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `${open}林月是我的妹妹，而且她从小怕水${close}`,
      settingUpdates: [
        { kind: 'relationship', statement: '林月是玩家的妹妹。', evidence: '林月是我的妹妹', anchors: ['林月', '妹妹'], entities: ['林月', '玩家'] },
        // NOTE the evidence: it must be the player's ACTUAL words ("她从小怕水"),
        // not a tidied-up restatement — "林月从小怕水" never appears in the tag.
        { ...goodUpdate, evidence: '她从小怕水' },
      ],
    }));
    expect(r.accepted).toHaveLength(2);
    expect(capturedEntries(sm)).toHaveLength(2);
  });

  it('stores the PLAYER original words as evidence, not the model paraphrase', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    // Player wrote it with extra spacing; the model echoed a normalized form.
    await run(sm, makeCtx({
      originalUserInput: `${open}林月  从小   怕水${close}`,
      settingUpdates: [{ ...goodUpdate, evidence: '林月 从小 怕水' }],
    }));
    // The persisted evidence is sliced back out of the raw input.
    expect(capturedEntries(sm)[0].capturedSetting?.evidence).toContain('从小');
    expect(capturedEntries(sm)[0].capturedSetting?.evidence).toMatch(/林月\s+从小\s+怕水/);
  });
});

describe('SettingCaptureStage — evidence gate', () => {
  it('rejects a statement whose evidence is not inside any tag', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `林月从小怕水。${open}她住在城南${close}`,
      // "林月从小怕水" is in the input but OUTSIDE the tag.
      settingUpdates: [goodUpdate],
    }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('no_evidence');
    expect(capturedEntries(sm)).toHaveLength(0);
  });

  it('refuses evidence stitched across two different tag segments', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `${open}林月${close} 走了很久 ${open}怕水${close}`,
      settingUpdates: [{ ...goodUpdate, evidence: '林月怕水' }],
    }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('cross_segment');
  });

  it('action-queue text can never be forged into evidence', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    // PreProcess prepends the queue to `userInput`; `originalUserInput` stays pristine.
    const ctx = makeCtx({
      originalUserInput: `${open}林月怕水${close}`,
      settingUpdates: [{ ...goodUpdate, statement: '玩家装备了破旧铁剑。', evidence: '[装备] 玩家装备了「破旧铁剑」', anchors: ['铁剑'], entities: [] }],
    });
    ctx.userInput = `[装备] 玩家装备了「破旧铁剑」\n\n${open}林月怕水${close}`;
    const r = await run(sm, ctx);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('no_evidence');
  });

  it('rejects everything when the round has no tag at all', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: '我带她去码头。',
      settingUpdates: [goodUpdate],
    }));
    expect(r.hadTag).toBe(false);
    expect(r.rejected).toEqual([{ candidate: null, reason: 'no_tag' }]);
    expect(sm.get(paths.slotWorldBooks)).toBeUndefined();
  });

  it('matchEvidenceInSegments never matches across segments', () => {
    const { segments } = scanSettingTags(`${open}林月${close}x${open}怕水${close}`);
    expect(matchEvidenceInSegments('林月', segments)?.segmentIndex).toBe(0);
    expect(matchEvidenceInSegments('怕水', segments)?.segmentIndex).toBe(1);
    expect(matchEvidenceInSegments('林月怕水', segments)).toBeNull();
  });
});

describe('SettingCaptureStage — shape & token gates', () => {
  const base = `${open}林月从小怕水${close}`;

  async function reject(update: RawSettingUpdate) {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({ originalUserInput: base, settingUpdates: [update] }));
    expect(r.accepted).toHaveLength(0);
    return r.rejected[0];
  }

  it('rejects an unknown kind', async () => {
    expect((await reject({ ...goodUpdate, kind: 'story_constraint' })).reason).toBe('shape');
  });

  it('rejects a missing / non-string statement', async () => {
    expect((await reject({ ...goodUpdate, statement: 123 })).reason).toBe('shape');
    expect((await reject({ ...goodUpdate, statement: '  ' })).reason).toBe('shape');
  });

  it('rejects control markers smuggled into the statement', async () => {
    expect((await reject({ ...goodUpdate, statement: '林月怕水 <设定>x</设定>' })).reason).toBe('shape');
    expect((await reject({ ...goodUpdate, statement: '林月怕水 {{PLAYER}}' })).reason).toBe('shape');
  });

  it('rejects instead of truncating an over-long statement', async () => {
    // A half-sentence rule is worse than no rule.
    expect((await reject({ ...goodUpdate, statement: 'x'.repeat(300) })).reason).toBe('too_long');
  });

  it('rejects non-array anchors / entities', async () => {
    expect((await reject({ ...goodUpdate, anchors: 'linyue' })).reason).toBe('shape');
    expect((await reject({ ...goodUpdate, entities: { a: 1 } })).reason).toBe('shape');
  });

  it('rejects anchors that appear in neither statement nor evidence', async () => {
    const r = await reject({ ...goodUpdate, anchors: ['林月', '完全没提过的词'] });
    expect(r.reason).toBe('bad_anchor');
  });

  it('rejects an empty anchor list (the entry could never be retrieved)', async () => {
    expect((await reject({ ...goodUpdate, anchors: [] })).reason).toBe('bad_anchor');
  });

  it('rejects entities that appear nowhere, and duplicate entities', async () => {
    expect((await reject({ ...goodUpdate, entities: ['张三'] })).reason).toBe('bad_entity');
    expect((await reject({ ...goodUpdate, entities: ['林月', '林月'] })).reason).toBe('bad_entity');
  });

  it('rejects more than two entities', async () => {
    expect((await reject({ ...goodUpdate, entities: ['林月', '玩家', '张三'] })).reason).toBe('too_long');
  });
});

describe('SettingCaptureStage — no-op is NOT a failure', () => {
  it('re-stating an existing setting is reported as a no-op, not a rejection', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const ctx = makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    });
    const first = await run(sm, ctx);
    expect(first.accepted).toHaveLength(1);

    const second = await run(sm, makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }));
    expect(second.accepted).toHaveLength(0);
    expect(second.rejected).toHaveLength(0);
    expect(second.noops).toHaveLength(1);
    expect(second.noops[0].existingEntryId).toBe(first.accepted[0].entryId);
    expect(capturedEntries(sm)).toHaveLength(1); // no duplicate row
  });

  it('a retracted entry does not block re-capturing the same setting', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    await run(sm, makeCtx({ originalUserInput: `${open}林月从小怕水${close}`, settingUpdates: [goodUpdate] }));

    // Simulate the player retracting it.
    const books = slotBooks(sm);
    books[0].entries[0].capturedSetting!.status = 'retracted';
    books[0].entries[0].enabled = false;
    sm.set(paths.slotWorldBooks, books);

    const again = await run(sm, makeCtx({ originalUserInput: `${open}林月从小怕水${close}`, settingUpdates: [goodUpdate] }));
    expect(again.accepted).toHaveLength(1);
  });
});

describe('SettingCaptureStage — caps are visible', () => {
  it('reports overflow past the per-round cap instead of dropping it silently', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const many = Array.from({ length: 13 }, (_, i) => ({
      kind: 'world_fact',
      statement: `设定编号 ${i}`,
      evidence: `设定编号 ${i}`,
      anchors: [`设定编号 ${i}`],
      entities: [],
    } as RawSettingUpdate));
    const tag = `${open}${many.map((_, i) => `设定编号 ${i}`).join('。')}${close}`;

    const r = await run(sm, makeCtx({ originalUserInput: tag, settingUpdates: many }));
    expect(r.accepted).toHaveLength(10);
    expect(r.rejected.filter((x) => x.reason === 'overflow')).toHaveLength(3);
  });

  it('refuses new captures once the active cap is reached', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    // Pre-fill the book right up to the cap.
    const entries = Array.from({ length: MAX_ACTIVE_CAPTURED_ENTRIES }, (_, i) => ({
      id: `cap_${i}`,
      title: 't',
      content: `填充设定 ${i}`,
      type: 'world_lore' as const,
      scope: ['main' as const],
      injectionMode: 'match_any' as const,
      capturedSetting: {
        schemaVersion: 1 as const, source: 'user-captured' as const, kind: 'world_fact' as const,
        evidence: 'x', capturedRound: 0, inputHash: 'h', status: 'active' as const,
        entityRefs: [], injectedCount: 0,
      },
    }));
    sm.set(paths.slotWorldBooks, [{
      id: CAPTURED_SETTINGS_BOOK_ID, title: '自动设定集', ownership: 'slot',
      origin: 'system-captured', enabled: true, entries,
    }]);

    const r = await run(sm, makeCtx({ originalUserInput: `${open}林月从小怕水${close}`, settingUpdates: [goodUpdate] }));
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('capacity');
  });
});

describe('SettingCaptureStage — switches, fail-soft, counters', () => {
  it('writes nothing when the feature is disabled', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }), false);
    expect(r).toEqual(expect.objectContaining({ accepted: [], hadTag: false }));
    expect(sm.get(paths.slotWorldBooks)).toBeUndefined();
  });

  it('a tag with no model output degrades cleanly (no accepted, no rejected)', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({ originalUserInput: `${open}林月从小怕水${close}` }));
    expect(r.hadTag).toBe(true);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toHaveLength(0);
    expect(r.segments).toHaveLength(1); // available to pre-fill the manual-add fallback
  });

  it('never throws — an internal failure becomes a rejection', async () => {
    const broken = {
      get: () => { throw new Error('state exploded'); },
      set: () => {},
    } as unknown as StateManager;
    const stage = new SettingCaptureStage(broken, paths, {
      isEnabled: () => true,
      getTagNames: () => ['设定'],
      getLabels: () => labels,
    });
    const out = await stage.execute(makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }));
    const r = out.meta['settingCapture'] as SettingCaptureResult;
    expect(r.rejected[0].reason).toBe('internal_error');
  });

  it('folds this round injection hits into the entry counters', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 5 } });
    const first = await run(sm, makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }));
    const id = first.accepted[0].entryId;

    await run(sm, makeCtx({ originalUserInput: '普通回合', capturedHits: [id] }));
    const entry = capturedEntries(sm).find((e) => e.id === id);
    expect(entry?.capturedSetting?.injectedCount).toBe(1);
    expect(entry?.capturedSetting?.lastInjectedRound).toBe(5);
  });

  it('leaves other slot books untouched when writing', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    sm.set(paths.slotWorldBooks, [{ id: 'other', title: 'Other', entries: [] }]);
    await run(sm, makeCtx({ originalUserInput: `${open}林月从小怕水${close}`, settingUpdates: [goodUpdate] }));
    const books = slotBooks(sm);
    expect(books.map((b) => b.id)).toEqual(['other', CAPTURED_SETTINGS_BOOK_ID]);
  });
});

// ═══════════════════════════════════════════════════════════
//  P1 code-review regressions (2026-08-21)
// ═══════════════════════════════════════════════════════════

describe('evidence slicing must never return the WRONG quote', () => {
  it('never returns a fragment that does not contain the claimed evidence', () => {
    // NFD input (base char + combining acute) — `normalizeForEvidence` composes the
    // whole string at once, while the raw walk normalizes one code unit at a time.
    // The two can disagree, and an unverified walk could hand back a lone combining
    // mark as "the player's own words".
    const raw = 'e\u0301X 是关键';
    const { segments } = scanSettingTags(`${open}${raw}${close}`);
    const hit = matchEvidenceInSegments('X', segments);
    expect(hit).not.toBeNull();
    expect(hit!.originalText).not.toBe('\u0301');
    // Whatever is returned must round-trip: normalizing it still contains the needle.
    expect(hit!.originalText.normalize('NFKC')).toContain('X');
  });

  it('a plain-ASCII / plain-CJK slice is still tight, not widened', () => {
    const { segments } = scanSettingTags(`${open}林月从小怕水，住在城南${close}`);
    const hit = matchEvidenceInSegments('林月从小怕水', segments);
    expect(hit?.originalText).toBe('林月从小怕水');
  });

  it('persisted evidence always round-trips against the tag content', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const raw = 'e\u0301X 是关键设定';
    await run(sm, makeCtx({
      originalUserInput: `${open}${raw}${close}`,
      settingUpdates: [{
        kind: 'world_fact', statement: 'X 是关键设定。', evidence: 'X 是关键设定',
        anchors: ['关键设定'], entities: [],
      }],
    }));
    const stored = capturedEntries(sm)[0]?.capturedSetting?.evidence ?? '';
    expect(stored.normalize('NFKC')).toContain('关键设定');
  });
});

describe('anchor quality filter (design §6.2 rule 6)', () => {
  function stage(sm: MockStateManager, stopwords: string[]) {
    return new SettingCaptureStage(sm as unknown as StateManager, paths, {
      isEnabled: () => true,
      getTagNames: () => ['设定'],
      getLabels: () => labels,
      getAnchorStopwords: () => stopwords,
    });
  }

  it('strips single-character and stopword anchors but keeps the entry', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const out = await stage(sm, ['这个']).execute(makeCtx({
      originalUserInput: `${open}林月从小怕水，这个是重点${close}`,
      settingUpdates: [{
        ...goodUpdate,
        statement: '林月从小怕水，这个是重点。',
        evidence: '林月从小怕水，这个是重点',
        anchors: ['林月', '怕', '这个'],
      }],
    }));
    const r = out.meta['settingCapture'] as SettingCaptureResult;
    expect(r.accepted).toHaveLength(1);
    // '怕' (single char) and '这个' (stopword) are gone; only the useful anchor remains.
    expect(r.accepted[0].candidate.anchors).toEqual(['林月']);
    expect(capturedEntries(sm)[0].keywords).toEqual(['林月']);
  });

  it('rejects the entry when EVERY anchor is filtered out (it could never be retrieved)', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const out = await stage(sm, ['这个']).execute(makeCtx({
      originalUserInput: `${open}这个是重点${close}`,
      settingUpdates: [{
        kind: 'world_fact', statement: '这个是重点。', evidence: '这个是重点',
        anchors: ['这个'], entities: [],
      }],
    }));
    const r = out.meta['settingCapture'] as SettingCaptureResult;
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toBe('bad_anchor');
    expect(r.rejected[0].detail).toContain('weak:');
  });

  it('single-character filtering works even with no pack stopword list', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const out = await stage(sm, []).execute(makeCtx({
      originalUserInput: `${open}水很深${close}`,
      settingUpdates: [{
        kind: 'world_fact', statement: '水很深。', evidence: '水很深',
        anchors: ['水'], entities: [],
      }],
    }));
    const r = out.meta['settingCapture'] as SettingCaptureResult;
    expect(r.rejected[0].reason).toBe('bad_anchor');
  });
});

describe('classifyEvidenceFailure', () => {
  it('reports cross_segment only when the evidence really is a stitch', () => {
    const { segments } = scanSettingTags(`${open}林月${close}x${open}怕水${close}`);
    expect(classifyEvidenceFailure('林月怕水', segments)).toBe('cross_segment');
  });

  it('reports no_evidence for outright fabrication, even with several tags present', () => {
    // Picking the label from "this round had >1 tag" would mislabel this as stitching
    // and hide the more serious failure.
    const { segments } = scanSettingTags(`${open}林月${close}x${open}怕水${close}`);
    expect(classifyEvidenceFailure('张三会飞', segments)).toBe('no_evidence');
  });

  it('reports no_evidence when there is only one segment', () => {
    const { segments } = scanSettingTags(`${open}林月${close}`);
    expect(classifyEvidenceFailure('张三', segments)).toBe('no_evidence');
  });

  it('the stage uses the honest label', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const r = await run(sm, makeCtx({
      originalUserInput: `${open}林月${close} 走了 ${open}怕水${close}`,
      settingUpdates: [{ ...goodUpdate, evidence: '张三会飞', anchors: ['张三'], entities: [] }],
    }));
    expect(r.rejected[0].reason).toBe('no_evidence');
  });
});

describe('SettingCaptureStage — persisted last-round record (acceptance fix 2026-08-21)', () => {
  // Why this exists: the only feedback used to be a 10-second toast. A player reading a
  // 3000-character reply missed it, found the world-book tab empty, and had no way to
  // learn what happened. The record backs a standing banner in the panel.

  function lastOf(sm: MockStateManager) {
    return sm.get<{ round: number; accepted: number; noops: number;
      rejected: Array<{ reason: string; count: number }>; segmentsPreview: string }>(
      paths.settingCaptureLast);
  }

  it('writes a summary on a tagged round — accepted case', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 62 } });
    await run(sm, makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [goodUpdate],
    }));
    const rec = lastOf(sm);
    expect(rec).toMatchObject({ round: 62, accepted: 1, noops: 0 });
    expect(rec?.segmentsPreview).toContain('林月从小怕水');
  });

  it('writes the summary even when EVERYTHING was rejected — that is its whole point', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 62 } });
    await run(sm, makeCtx({
      originalUserInput: `${open}林月从小怕水${close}`,
      settingUpdates: [
        { ...goodUpdate, statement: 'x'.repeat(300) },              // too_long
        { ...goodUpdate, evidence: '完全对不上的引文' },              // no_evidence
      ],
    }));
    const rec = lastOf(sm);
    expect(rec?.accepted).toBe(0);
    const reasons = Object.fromEntries((rec?.rejected ?? []).map((r) => [r.reason, r.count]));
    expect(reasons['too_long']).toBe(1);
    expect(reasons['no_evidence']).toBe(1);
    // The player's words survive for the manual-add prefill.
    expect(rec?.segmentsPreview).toBe('林月从小怕水');
  });

  it('does NOT touch the record on an ordinary untagged round (zero-touch saves)', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 5 } });
    await run(sm, makeCtx({ originalUserInput: '我环顾四周。' }));
    expect(sm.get(paths.settingCaptureLast)).toBeUndefined();
  });

  it('caps the preview so a giant tag cannot bloat the save', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    const big = 'x'.repeat(900);
    await run(sm, makeCtx({ originalUserInput: `${open}${big}${close}` }));
    expect((lastOf(sm)?.segmentsPreview ?? '').length).toBeLessThanOrEqual(600);
  });

  it('each tagged round overwrites the previous record', async () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    await run(sm, makeCtx({ originalUserInput: `${open}第一回${close}`,
      settingUpdates: [{ kind: 'world_fact', statement: '第一回。', evidence: '第一回', anchors: ['第一回'], entities: [] }] }));
    sm.set(paths.roundNumber, 2);
    await run(sm, makeCtx({ originalUserInput: `${open}第二回${close}` }));
    expect(lastOf(sm)?.round).toBe(2);
    expect(lastOf(sm)?.accepted).toBe(0);
  });
});
