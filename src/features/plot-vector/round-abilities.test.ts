/**
 * The round's own abilities (rebuild plan §6, I3/I21): one block of cards after Step2's JSON, read card by
 * card when it is broken, matched by name to the entries that actually entered the save; each passing card is
 * bound, anything else leaves only that entry in the backlog. Cards of entries that left or changed go.
 */
import { describe, expect, it } from 'vitest';
import { bindRoundAbilities, readAbilityBlock, ROUND_PROBLEMS } from './round-abilities';
import { abilityBacklog } from './ability-backlog';
import { bindCard, initialVectorState, type VectorState } from './runtime';
import { capabilityKey, type SavedElement } from './genesis/post-save';

const entry = (id: string, kind: SavedElement['kind'], name: string, extra: Record<string, unknown> = {}): SavedElement =>
  ({ id, kind, capability: { name, description: `${name}的描述`, ...extra } });
const tea = entry('item:tea', 'item', '热茶'), talk = entry('talent:name:口才', 'talent', '口才'), fever = entry('effect:name:发烧', 'effect', '发烧');
const rain = entry('environment:name:细雨', 'environment', '细雨', { 效果: '路滑' });
const cardFor = (name: string, type: string, onPass = 'return { push: 1 };') => ({ for: name, type, summary: `${name}的卡`, onPass });
const block = (cards: unknown[]) => readAbilityBlock(JSON.stringify(cards));
const idsOf = (state: VectorState) => state.cards.map(c => c.task.entry.id).sort();

describe('reading the block', () => {
  it('reads an array, a single object, and a fenced block', () => {
    expect(readAbilityBlock(JSON.stringify([cardFor('热茶', 'item')]))).toEqual([{ for: '热茶', card: cardFor('热茶', 'item') }]);
    expect(readAbilityBlock(JSON.stringify(cardFor('热茶', 'item')))).toEqual([{ for: '热茶', card: cardFor('热茶', 'item') }]);
    expect(readAbilityBlock('```json\n' + JSON.stringify([cardFor('热茶', 'item')]) + '\n```')).toHaveLength(1);
    expect(readAbilityBlock(undefined)).toEqual([]);
    expect(readAbilityBlock('   ')).toEqual([]);
  });
  it('a broken block is read card by card: one broken card loses only itself, and still names its entry', () => {
    const good = JSON.stringify(cardFor('热茶', 'item'));
    const broken = '{"for":"口才","type":"talent","summary":"s","onPass":"return { social: 1 }"';   // unterminated
    const text = `[${good}, {"for":"发烧","type":"status","summary":"s","onPass": return 1 }, ${broken}`;
    const cards = readAbilityBlock(text);
    expect(cards.map(c => [c.for, c.card ? 'card' : 'broken'])).toEqual([['热茶', 'card'], ['发烧', 'broken'], ['口才', 'broken']]);
  });
  it('braces inside strings do not split a card', () => {
    const cards = readAbilityBlock(`[${JSON.stringify(cardFor('热茶', 'item', 'if (ctx.back) { return {}; } return { push: 1 };'))}, {bad`);
    expect(cards[0]).toMatchObject({ for: '热茶', card: { onPass: 'if (ctx.back) { return {}; } return { push: 1 };' } });
  });
});

describe('binding this round\'s abilities', () => {
  it('an item, a talent and a status acquired together are each bound by name; the type follows the entry', () => {
    const { state, gained } = bindRoundAbilities(initialVectorState(), [], [tea, talk, fever],
      block([cardFor('口才', 'talent'), cardFor('热茶', 'item'), cardFor('发烧', 'item')]));
    expect(idsOf(state)).toEqual(['effect:name:发烧', 'item:tea', 'talent:name:口才']);
    expect(state.cards.find(c => c.task.entry.id === 'effect:name:发烧')?.spec.type).toBe('status');
    expect(gained.map(c => c.task.entry.id).sort()).toEqual(idsOf(state));
    expect(state.tasks).toEqual([]);
  });
  it('one broken card leaves only its entry waiting, with the reason and the broken text', () => {
    const text = `[${JSON.stringify(cardFor('热茶', 'item'))}, {"for":"口才","type":"talent","onPass": oops}, ${JSON.stringify(cardFor('发烧', 'status'))}]`;
    const { state } = bindRoundAbilities(initialVectorState(), [], [tea, talk, fever], readAbilityBlock(text));
    expect(idsOf(state)).toEqual(['effect:name:发烧', 'item:tea']);
    expect(state.tasks).toEqual([expect.objectContaining({ error: ROUND_PROBLEMS.broken, raw: expect.stringContaining('oops') })]);
    expect(abilityBacklog(state, [tea, talk, fever]).map(b => [b.id, b.state])).toEqual([['talent:name:口才', 'failed']]);
  });
  it('a card that fails the one check, a missing card and a missing block each leave the entry waiting with its reason', () => {
    const failing = bindRoundAbilities(initialVectorState(), [], [tea], block([cardFor('热茶', 'item', 'while (1) {}')]));
    expect(failing.state.tasks).toEqual([expect.objectContaining({ error: 'forbidden token: while', raw: expect.stringContaining('while') })]);
    const missing = bindRoundAbilities(initialVectorState(), [], [tea, talk], block([cardFor('热茶', 'item')]));
    expect(missing.state.tasks.map(t => [t.task.entry.id, t.error])).toEqual([['talent:name:口才', ROUND_PROBLEMS.missing]]);
    const none = bindRoundAbilities(initialVectorState(), [], [tea], undefined);
    expect(none.state.tasks.map(t => t.error)).toEqual([ROUND_PROBLEMS.noBlock]);
  });
  it('only entries that entered the save are bound; cards for anything else are dropped', () => {
    const { state } = bindRoundAbilities(initialVectorState(), [], [tea], block([cardFor('热茶', 'item'), cardFor('没入档的东西', 'item')]));
    expect(idsOf(state)).toEqual(['item:tea']);
  });
  it('an entry that was already there is not bound again; a quantity change is not a new entry', () => {
    const before = [entry('item:tea', 'item', '热茶')];
    const { state, gained } = bindRoundAbilities(initialVectorState(), before, [tea], block([cardFor('热茶', 'item')]));
    expect(gained).toEqual([]);
    expect(state.tasks).toEqual([]);
  });
  it('same name on two new entries with no card of the right type: neither guesses, both wait with the reason', () => {
    const hot = entry('effect:name:热茶', 'effect', '热茶');
    const { state } = bindRoundAbilities(initialVectorState(), [], [tea, hot],
      block([cardFor('热茶', 'talent', 'return { drag: 1 };'), cardFor('热茶', 'talent', 'return { push: 1 };')]));
    expect(state.cards).toEqual([]);
    expect(state.tasks.map(t => t.error)).toEqual([ROUND_PROBLEMS.ambiguous, ROUND_PROBLEMS.ambiguous]);
  });
  it('a broken card still names its entry when the name has escaped quotes', () => {
    expect(readAbilityBlock('[{"for":"\\"老\\"茶","onPass": oops}]')[0].for).toBe('"老"茶');
  });
  it('same name on two new entries: each card goes to the entry of its own type', () => {
    const hot = entry('effect:name:热茶', 'effect', '热茶');
    const { state } = bindRoundAbilities(initialVectorState(), [], [tea, hot],
      block([cardFor('热茶', 'status', 'return { drag: 1 };'), cardFor('热茶', 'item', 'return { push: 1 };')]));
    expect(state.cards.map(c => [c.task.entry.id, c.spec.onPass]).sort()).toEqual([
      ['effect:name:热茶', 'return { drag: 1 };'], ['item:tea', 'return { push: 1 };']]);
  });
  it('environment: a changed tag replaces its card; changed without a card, the old one stops; gone, it is removed', () => {
    const first = bindRoundAbilities(initialVectorState(), [], [rain], block([cardFor('细雨', 'environment', 'return { xPush: 0.9 };')])).state;
    const heavier = entry('environment:name:细雨', 'environment', '细雨', { 效果: '路很滑' });
    const replaced = bindRoundAbilities(first, [rain], [heavier], block([cardFor('细雨', 'environment', 'return { xPush: 0.8 };')])).state;
    expect(replaced.cards.map(c => c.spec.onPass)).toEqual(['return { xPush: 0.8 };']);
    const stale = bindRoundAbilities(first, [rain], [heavier], block([])).state;
    expect(stale.cards).toEqual([]);
    expect(abilityBacklog(stale, [heavier]).map(b => b.id)).toEqual(['environment:name:细雨']);
    expect(bindRoundAbilities(first, [rain], [], block([])).state.cards).toEqual([]);
  });
  // PO D5 (2026-09-26): the environment list is rewritten every round; new wording alone keeps the card.
  it('environment: a reworded description keeps its card, is not waiting and is not announced again', () => {
    const first = bindRoundAbilities(initialVectorState(), [], [rain], block([cardFor('细雨', 'environment', 'return { xPush: 0.9 };')])).state;
    const reworded = { ...rain, capability: { ...rain.capability, description: '细雨绵绵，石板路湿漉漉的' } };
    const next = bindRoundAbilities(first, [rain], [reworded], block([]));
    expect(next.gained).toEqual([]);
    expect(next.state.cards.map(c => c.spec.onPass)).toEqual(['return { xPush: 0.9 };']);
    expect(abilityBacklog(next.state, [reworded])).toEqual([]);
    // An item's wording already worked this way; a talent or a status still takes a new card when its text changes.
    expect(capabilityKey(reworded)).toBe(capabilityKey(rain));
    expect(capabilityKey({ ...talk, capability: { ...talk.capability, description: '新说法' } })).not.toBe(capabilityKey(talk));
  });
  it('an unchanged entry keeps its card, and one still in the save but not projectable keeps it too', () => {
    const first = bindRoundAbilities(initialVectorState(), [], [rain, tea], block([cardFor('细雨', 'environment'), cardFor('热茶', 'item')])).state;
    expect(idsOf(bindRoundAbilities(first, [rain, tea], [rain, tea], undefined).state)).toEqual(['environment:name:细雨', 'item:tea']);
    const kept = bindRoundAbilities(first, [rain, tea], [tea], undefined, id => id === 'environment:name:细雨').state;
    expect(idsOf(kept)).toEqual(['environment:name:细雨', 'item:tea']);
  });
  it('a row of an entry that got its card is removed; rows of entries that left are dropped', () => {
    const waiting: VectorState = { ...initialVectorState(), tasks: [
      { task: { key: capabilityKey(tea), actionId: 'x', entry: tea }, error: 'old' },
      { task: { key: capabilityKey(talk), actionId: 'x', entry: talk }, error: 'old' }] };
    const card = bindCard({ key: capabilityKey(tea), actionId: 'x', entry: tea }, cardFor('热茶', 'item'));
    const { state } = bindRoundAbilities({ ...waiting, cards: [card] }, [tea, talk], [tea], undefined);
    expect(state.tasks).toEqual([]);   // talk left the save; tea's row stays only while it has no card
  });
});
