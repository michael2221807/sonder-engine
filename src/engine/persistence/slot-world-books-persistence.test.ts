/**
 * Canon Capture persistence gate.
 *
 * CLAUDE.md treats the save chain as the foundation every other feature rests on:
 * adding a field to the state tree obliges us to prove it round-trips through save /
 * load / backup, and that it does NOT leak into the prompt snapshot.
 *
 * `系统.扩展.slotWorldBooks` was chosen precisely so persistence comes for free (it is
 * part of `GameStateTree`, unlike `WorldBookStorage`'s IndexedDB records). "For free"
 * is a claim, so it gets a test.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_ENGINE_PATHS } from '../pipeline/types';
import { stringifySnapshotForPrompt } from '../memory/snapshot-sanitizer';
import { createMockStateManager } from '../__test-utils__';
import { createCapturedBook, addCapturedEntry } from '../prompt/captured-entry-mutations';
import { CAPTURED_SETTINGS_BOOK_ID } from '../prompt/world-book';
import type { WorldBook } from '../prompt/world-book';

const paths = DEFAULT_ENGINE_PATHS;

const labels = {
  bookTitle: '自动设定集',
  kind: { character: '人物设定', relationship: '关系设定', world_fact: '世界设定' },
};

function makeCapturedBooks(statement = '林月从小怕水。'): WorldBook[] {
  const { book } = addCapturedEntry(
    createCapturedBook(labels),
    { kind: 'character', statement, evidence: '林月从小怕水', anchors: ['林月'], entities: ['林月'] },
    { round: 4, inputHash: 'h', labels },
  );
  return [book];
}

describe('slotWorldBooks — state tree round-trip', () => {
  it('survives a snapshot → rollback cycle unchanged', () => {
    const { sm } = createMockStateManager({ 元数据: { 回合序号: 1 } });
    sm.set(paths.slotWorldBooks, makeCapturedBooks());

    const snapshot = sm.toSnapshot();
    sm.set(paths.slotWorldBooks, []); // simulate a later round wiping it
    expect(sm.get<WorldBook[]>(paths.slotWorldBooks)).toHaveLength(0);

    sm.rollbackTo(snapshot);
    const restored = sm.get<WorldBook[]>(paths.slotWorldBooks);
    expect(restored).toHaveLength(1);
    expect(restored?.[0].id).toBe(CAPTURED_SETTINGS_BOOK_ID);
    expect(restored?.[0].entries[0].content).toBe('林月从小怕水。');
    expect(restored?.[0].entries[0].capturedSetting?.capturedRound).toBe(4);
  });

  it('survives a JSON serialize → deserialize cycle (save file shape)', () => {
    const books = makeCapturedBooks();
    const revived = JSON.parse(JSON.stringify(books)) as WorldBook[];
    expect(revived[0].ownership).toBe('slot');
    expect(revived[0].origin).toBe('system-captured');
    expect(revived[0].entries[0].capturedSetting).toEqual(books[0].entries[0].capturedSetting);
    expect(revived[0].entries[0].matchSource).toBe('focused');
  });

  it('two slots keep independent captured books (no cross-slot bleed)', () => {
    // The whole reason for living in the state tree instead of the profile-keyed
    // IndexedDB store: profile books are shared by every slot, captured ones must not be.
    const { sm: slotA } = createMockStateManager({});
    const { sm: slotB } = createMockStateManager({});
    slotA.set(paths.slotWorldBooks, makeCapturedBooks('A 的设定。'));
    slotB.set(paths.slotWorldBooks, makeCapturedBooks('B 的设定。'));

    expect(slotA.get<WorldBook[]>(paths.slotWorldBooks)?.[0].entries[0].content).toBe('A 的设定。');
    expect(slotB.get<WorldBook[]>(paths.slotWorldBooks)?.[0].entries[0].content).toBe('B 的设定。');
  });

  it('an old save without the field loads as an empty list, not a crash', () => {
    const { sm } = createMockStateManager({ 系统: { 扩展: { engramMemory: {} } } });
    const books = sm.get<WorldBook[]>(paths.slotWorldBooks);
    expect(books).toBeUndefined();
    expect(Array.isArray(books) ? books : []).toEqual([]);
  });
});

describe('slotWorldBooks — prompt snapshot isolation', () => {
  it('is stripped from GAME_STATE_JSON', () => {
    // Entries reach the model through the world-book budget block. Leaving them in the
    // raw state JSON would inject every entry, every round, bypassing the budget AND
    // the 60% captured quota entirely.
    const snapshot = {
      系统: { 扩展: { slotWorldBooks: makeCapturedBooks() } },
      角色: { 基础信息: { 姓名: '主角' } },
    };
    const json = stringifySnapshotForPrompt(snapshot, true, 0);
    expect(json).not.toContain('slotWorldBooks');
    expect(json).not.toContain('林月从小怕水');
    expect(json).toContain('主角'); // the rest of the tree is untouched
  });

  it('stays stripped in NSFW mode too (the strip is unconditional)', () => {
    const snapshot = { 系统: { 扩展: { slotWorldBooks: makeCapturedBooks() } } };
    expect(stringifySnapshotForPrompt(snapshot, false, 0)).not.toContain('slotWorldBooks');
    expect(stringifySnapshotForPrompt(snapshot, true, 0)).not.toContain('slotWorldBooks');
  });
});
