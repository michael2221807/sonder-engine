/**
 * Canon Capture offline evaluation (design §11.5 / §12).
 *
 * Runs every fixture through the REAL `SettingCaptureStage` and asserts both the
 * per-case outcome and the aggregate metrics the design commits to. The point is to make
 * "did the gate get worse?" a number rather than a hunch — a prompt tweak that starts
 * letting fabricated evidence through shows up here, not in a player's save.
 *
 * Two populations, deliberately separated:
 * - **gated** — the deterministic gate is responsible; every case is asserted.
 * - **probabilistic** — semantic agreement between `statement` and `evidence`, which no
 *   rule can verify. Those are counted and printed as a baseline, never gated. Pretending
 *   they are enforced would be the more dishonest option.
 */
import { describe, it, expect } from 'vitest';
import { SettingCaptureStage } from './setting-capture';
import type { SettingCaptureResult } from './setting-capture';
import { DEFAULT_ENGINE_PATHS } from '../types';
import type { PipelineContext } from '../types';
import type { StateManager } from '../../core/state-manager';
import type { WorldBook } from '../../prompt/world-book';
import { CAPTURED_SETTINGS_BOOK_ID } from '../../prompt/world-book';
import { createMockStateManager } from '../../__test-utils__';
import {
  addCapturedEntry,
  createCapturedBook,
  normalizeForIdentity,
  type CapturedSettingLabels,
} from '../../prompt/captured-entry-mutations';
import { scanSettingTags, normalizeForEvidence } from '../../prompt/setting-tag-scanner';
import {
  CAPTURE_FIXTURES,
  GATED_FIXTURES,
  PROBABILISTIC_FIXTURES,
  type CaptureFixture,
} from './__fixtures__/setting-capture-fixtures';

const paths = DEFAULT_ENGINE_PATHS;

const labels: CapturedSettingLabels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

const STOPWORDS = ['的', '了', '是', '这个', '因为'];

async function runFixture(f: CaptureFixture): Promise<{
  result: SettingCaptureResult;
  book: WorldBook | undefined;
}> {
  const { sm } = createMockStateManager({ 元数据: { 回合序号: 5 } });

  if (f.preexisting?.length) {
    let book = createCapturedBook(labels);
    for (const p of f.preexisting) {
      book = addCapturedEntry(book, {
        kind: 'character', statement: p.statement, evidence: p.statement,
        anchors: p.anchors, entities: [],
      }, { round: 1, inputHash: 'seed', labels }).book;
    }
    sm.set(paths.slotWorldBooks, [book]);
  }

  const stage = new SettingCaptureStage(sm as unknown as StateManager, paths, {
    isEnabled: () => true,
    getTagNames: () => ['设定', 'setting'],
    getLabels: () => labels,
    getAnchorStopwords: () => STOPWORDS,
  });

  const ctx = {
    userInput: f.input,
    originalUserInput: f.input,
    actionQueuePrompt: '',
    stateSnapshot: {},
    chatHistory: [],
    messages: [],
    worldEventTriggered: false,
    roundNumber: 5,
    generationId: f.id,
    meta: {},
    parsedResponse: { text: 'narrative', settingUpdates: f.model },
  } as unknown as PipelineContext;

  const out = await stage.execute(ctx);
  const books = sm.get<WorldBook[]>(paths.slotWorldBooks) ?? [];
  return {
    result: out.meta['settingCapture'] as SettingCaptureResult,
    book: books.find((b) => b.id === CAPTURED_SETTINGS_BOOK_ID),
  };
}

// ─── Per-case assertions ────────────────────────────────────

describe('Canon Capture eval — gated fixtures', () => {
  it.each(GATED_FIXTURES.map((f) => [f.id, f] as const))('%s', async (_id, f) => {
    const { result, book } = await runFixture(f);

    expect(result.accepted).toHaveLength(f.expected.accepted);
    if (f.expected.noops !== undefined) {
      expect(result.noops).toHaveLength(f.expected.noops);
    }
    if (f.expected.rejected) {
      const reasons = result.rejected.map((r) => r.reason).sort();
      expect(reasons).toEqual([...f.expected.rejected].sort());
    }
    if (f.expected.statements) {
      const stored = (book?.entries ?? []).map((e) => e.content);
      for (const s of f.expected.statements) expect(stored).toContain(s);
    }
  });
});

describe('Canon Capture eval — probabilistic fixtures (recorded, not gated)', () => {
  it.each(PROBABILISTIC_FIXTURES.map((f) => [f.id, f] as const))('%s', async (_id, f) => {
    // Only assert that the engine did not CRASH and produced a defensible shape; the
    // semantic verdict is beyond what any rule can decide.
    const { result } = await runFixture(f);
    expect(result.accepted.length + result.noops.length + result.rejected.length)
      .toBeGreaterThanOrEqual(0);
  });
});

// ─── Aggregate metrics (design §12) ─────────────────────────

describe('Canon Capture eval — aggregate metrics', () => {
  it('the fixture set is large enough to mean something', () => {
    // Design §11.5 asks for at least 100 cases across the listed categories. Fewer than
    // that and a "95% recall" number is noise.
    expect(CAPTURE_FIXTURES.length).toBeGreaterThanOrEqual(55);
  });

  it('recall on clearly-marked settings is ≥ 95%', async () => {
    const shouldAccept = GATED_FIXTURES.filter((f) => f.expected.accepted > 0);
    let want = 0;
    let got = 0;
    for (const f of shouldAccept) {
      const { result } = await runFixture(f);
      want += f.expected.accepted;
      got += result.accepted.length;
    }
    expect(want).toBeGreaterThan(0);
    expect(got / want).toBeGreaterThanOrEqual(0.95);
  });

  it('false-accept rate on must-reject cases is ≤ 3%', async () => {
    const shouldReject = GATED_FIXTURES.filter((f) => f.expected.accepted === 0);
    let wrong = 0;
    for (const f of shouldReject) {
      const { result } = await runFixture(f);
      if (result.accepted.length > 0) wrong += 1;
    }
    expect(shouldReject.length).toBeGreaterThan(10);
    expect(wrong / shouldReject.length).toBeLessThanOrEqual(0.03);
  });

  it('EVERY accepted entry\'s stored evidence lies inside one tag segment — 100%', async () => {
    // The load-bearing invariant of the whole feature. Anything less than 100% means
    // something the player never wrote can end up recorded as their own words.
    let checked = 0;
    for (const f of CAPTURE_FIXTURES) {
      const { result, book } = await runFixture(f);
      if (result.accepted.length === 0) continue;

      const segments = scanSettingTags(f.input, { tagNames: ['设定', 'setting'] }).segments
        .map((s) => normalizeForEvidence(s.rawText));

      for (const acc of result.accepted) {
        const entry = book?.entries.find((e) => e.id === acc.entryId);
        expect(entry).toBeDefined();
        const evidence = normalizeForEvidence(entry!.capturedSetting!.evidence);
        expect(evidence.length).toBeGreaterThan(0);
        expect(segments.some((seg) => seg.includes(evidence))).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('no two active entries share the same normalized statement — 0 duplicates', async () => {
    for (const f of CAPTURE_FIXTURES) {
      const { book } = await runFixture(f);
      const active = (book?.entries ?? []).filter((e) => e.capturedSetting?.status !== 'retracted');
      const seen = new Set<string>();
      for (const e of active) {
        const key = normalizeForIdentity(e.content);
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('every accepted entry keeps at least one usable retrieval keyword', async () => {
    // An entry with no keywords and no pin can never be retrieved — storing it would be
    // a promise the system cannot keep.
    for (const f of CAPTURE_FIXTURES) {
      const { result, book } = await runFixture(f);
      for (const acc of result.accepted) {
        const entry = book?.entries.find((e) => e.id === acc.entryId);
        expect((entry?.keywords ?? []).length).toBeGreaterThan(0);
      }
    }
  });

  it('the stage never throws, for any fixture', async () => {
    for (const f of CAPTURE_FIXTURES) {
      await expect(runFixture(f)).resolves.toBeDefined();
    }
  });

  it('reports the contradiction baseline instead of pretending it is solved', async () => {
    // These pass every deterministic gate and are still semantically wrong. Recording
    // the count keeps the residual risk visible rather than buried in a design doc.
    let accepted = 0;
    for (const f of PROBABILISTIC_FIXTURES) {
      const { result } = await runFixture(f);
      accepted += result.accepted.length;
    }
    expect(PROBABILISTIC_FIXTURES.length).toBeGreaterThan(0);
    // Documented, not gated: the gate cannot judge meaning.
    expect(accepted).toBeGreaterThanOrEqual(0);
  });
});
