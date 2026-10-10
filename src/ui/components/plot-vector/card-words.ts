// App doc: docs/user-guide/pages/game-main.md §3.18.5 · Card details
/**
 * Words for what a card does and how it grows (PO 2026-10-01; demo docs/demo/plot-vector-effect-and-start.html;
 * PO 2026-10-09: the face says what the card's own code does). The sentences are fixed templates from the i18n
 * glossary; what fills them is engine data — the behaviour read from the card's code, the declared growth read as
 * phrases, the trip's own record. On the face a clause is a short condition and a few chips (glyph and operator: an
 * add is filled, a multiplier outlined, a move an arrow); in the details each operation is a bubble that explains
 * itself on hover. Numbers show only when the player asked for exact numbers. Nothing here reads the model's text.
 */
import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { EffectMark, GrowthView, ReturnPhrase } from '@/features/plot-vector/card-describe';
import type { BehaviorAmount, BehaviorClause, BehaviorCondition, BehaviorOp, CardBehavior, VaryBy } from '@/features/plot-vector/card-behavior';
import type { CardTripReceipt } from '@/features/plot-vector/card-trip-receipt';
import type { ChannelName } from '@/features/plot-vector/contract/types';
import { CHANNEL_KEY, CHANNEL_MARK, CHANNEL_OF_ID, MARK_COLOR, MARK_GLYPH, OP_GLYPH, signed } from './effect-marks';

export type Translate = (key: string, params?: Record<string, unknown>) => string;
/** A keyword bubble: its mark and colour, its name, strength strokes, its number (exact only) and its hint. */
export interface Tok { mark?: EffectMark; color?: string; label: string; strength?: number; num?: string; tip: string }
export type Seg = { text: string } | { tok: Tok };
/** One chip on a card face: its glyphs and operator; `frame`: an add is filled, a multiplier or clearing outlined. */
export interface Chip { text: string; color: string; frame: 'fill' | 'line' | 'plain' }
/** One clause on a card face: its short conditions and its chips. */
export interface FaceClause { when: string[]; chips: Chip[] }
/** One clause in the details: its conditions in words (empty: always) and its operations as bubbles. */
export interface DetailClause { when: string; toks: Tok[] }

const D = 'mainGame.vectorTable.do.';
const glyphOf = (ch: ChannelName) => MARK_GLYPH[CHANNEL_MARK[ch]];
const colorOf = (ch: ChannelName) => MARK_COLOR[CHANNEL_MARK[ch]];
/** An amount that moves during a trip (not the level, which is fixed for the trip) is told as approximate. */
const moves = (a: BehaviorAmount) => !!a.varies && a.varies !== 'level';
/** Strokes for an add, against the unit card (+1): the same steps the old marks used. */
const addStrength = (v: number): 1 | 2 | 3 => (Math.abs(v) >= 3.5 ? 3 : Math.abs(v) >= 1.5 ? 2 : 1);

const K = 'mainGame.vectorTable.';

export class CardWords {
  constructor(private readonly t: Translate, private readonly locale: string, private readonly exact: boolean) {}

  private k(key: string, params?: Record<string, unknown>): string { return this.t(K + key, params); }
  private signed(value: number): string { return signed(value, this.locale); }
  private num(value: number): string { return new Intl.NumberFormat(this.locale, { maximumFractionDigits: 2 }).format(value); }

  /** One quantity as a bubble. */
  channel(ch: ChannelName, num?: string, extraTip?: string): Tok {
    const mark = CHANNEL_MARK[ch];
    return { mark, color: MARK_COLOR[mark], label: this.k(`channel.${CHANNEL_KEY[ch]}`), tip: [this.k(`fx.means.${ch}`), extraTip].filter(Boolean).join(' '),
      ...(num && this.exact ? { num } : {}) };
  }
  /** A word that is not a quantity (steps, turn, release, …) as a bubble; route and store words wear their mark. */
  private concept(word: 'step' | 'turn' | 'release' | 'convert' | 'relay' | 'echo' | 'depart' | 'store', num?: string): Tok {
    const means = { step: 'steps', turn: 'turn', release: 'release', convert: 'convert', relay: 'relay', echo: 'echo', depart: 'depart', store: 'store' }[word];
    const mark: EffectMark | undefined = word === 'step' || word === 'turn' ? 'route' : word === 'store' || word === 'release' ? 'store' : undefined;
    return { ...(mark ? { mark, color: MARK_COLOR[mark] } : {}), label: word === 'store' ? this.k('fx.mark.store') : this.k(`fx.${word}`),
      tip: this.k(`fx.means.${means}`), ...(num && this.exact ? { num } : {}) };
  }

  private name(ch: ChannelName): string { return this.k(`channel.${CHANNEL_KEY[ch]}`); }
  private d(key: string, params?: Record<string, unknown>): string { return this.t(D + key, params); }

  // ── What a card does (PO 2026-10-09) ──

  /** A condition, short (face) or in words (details and the face's hover line). */
  condition(c: BehaviorCondition, long: boolean): string {
    const form = long ? 'whenLong' : 'when';
    switch (c.kind) {
      case 'back': case 'forward': return this.d(`${form}.${c.kind}`);
      case 'chance': return this.d(`${form}.chance`, { n: c.percent });
      case 'line': {
        // Whole numbers (passes, steps) come as `< n` / `>= n`; the second pass on is "later", before it "first".
        const low = c.cmp === '<' || c.cmp === '<=';
        if (c.on === 'pass') {
          const first = c.cmp === '<' ? c.value - 1 : c.value;
          if (first === 1 && low) return this.d(`${form}.firstPass`);
          if (c.value === 2 && !low) return this.d(`${form}.laterPass`);
          return this.d(`${form}.${low ? 'passBefore' : 'passFrom'}`, { n: low ? first : c.value });
        }
        if (c.on === 'step') return this.d(`${form}.${low ? 'stepBelow' : 'stepAtLeast'}`, { n: this.num(c.value) });
        const side = ({ '<': 'Below', '<=': 'AtMost', '>=': 'AtLeast', '>': 'Above' } as const)[c.cmp];
        if (c.on === 'stored') return this.d(`${form}.stored${side}`, { n: this.num(c.value) });
        // Nothing of a quantity, or any of it.
        if (c.value === 0 && (c.cmp === '<=' || c.cmp === '>')) return this.d(`${form}.${c.cmp === '<=' ? 'none' : 'some'}`, { g: glyphOf(c.on), name: this.name(c.on) });
        return this.d(`${form}.${side[0].toLowerCase()}${side.slice(1)}`, { g: glyphOf(c.on), name: this.name(c.on), n: this.num(c.value) });
      }
    }
  }

  /** One operation as a face chip. */
  chip(op: BehaviorOp): Chip {
    const ex = this.exact;
    const plain = 'var(--color-text-secondary)';
    switch (op.kind) {
      case 'add': {
        const v = op.amount.value;
        const n = ex ? `${moves(op.amount) ? '~' : ''}${this.num(Math.abs(v))}` : '';
        return { text: `${glyphOf(op.channel)}${v > 0 ? '+' : '−'}${n}`, color: colorOf(op.channel), frame: 'fill' };
      }
      case 'scale': {
        const f = op.factor.value;
        return { text: `${glyphOf(op.channel)}${ex ? `×${this.num(f)}` : f > 1 ? '×' : '÷'}`, color: colorOf(op.channel), frame: 'line' };
      }
      case 'clear': return { text: `${glyphOf(op.channel)}0`, color: colorOf(op.channel), frame: 'line' };
      case 'convert': {
        const q = !ex ? '' : op.share === 'half' ? '½' : op.share === 'all' ? '' : op.amount ? this.num(op.amount.value) : '';
        const cap = ex && op.cap !== undefined ? `≤${this.num(op.cap)}` : '';
        return { text: `${glyphOf(op.from)}→${glyphOf(op.to)}${q}${cap}`, color: colorOf(op.to), frame: 'plain' };
      }
      case 'steps': return { text: `+${ex ? this.num(op.amount.value) : ''}${this.d('stepGlyph')}`, color: plain, frame: 'plain' };
      case 'xSteps': return { text: `${this.d('stepGlyph').trim()}×${ex ? this.num(op.factor.value) : ''}`, color: plain, frame: 'plain' };
      case 'turn': return { text: OP_GLYPH.turn, color: plain, frame: 'plain' };
      case 'store': return { text: `${OP_GLYPH.store}${glyphOf(op.from)}${ex ? this.num(op.amount.value) : ''}`, color: plain, frame: 'plain' };
      case 'release': return { text: `${OP_GLYPH.store}${OP_GLYPH.release}`, color: plain, frame: 'plain' };
      case 'relay': {
        const inner = op.ops.map(o => this.chip(o).text).join('');
        return { text: `${OP_GLYPH.relay}${inner}${op.echo ? this.d('op.echoShort') : ''}`, color: plain, frame: 'plain' };
      }
    }
  }

  /**
   * A card's clauses for its face: at most two rows (the rest is in its details), the case that does the most first
   * — a narrow card shows only that one.
   */
  face(behavior: CardBehavior): FaceClause[] {
    return [...behavior.clauses].sort((a, b) => b.ops.length - a.ops.length).slice(0, 2).map(c => ({ when: c.when.map(w => this.condition(w, false)), chips: c.ops.map(op => this.chip(op)) }));
  }

  /** The face's hover line: every clause in words. */
  faceTip(behavior: CardBehavior): string {
    const lines = behavior.clauses.map(c => {
      const what = c.ops.map(op => this.opWord(op)).join(this.d('join'));
      return c.when.length ? this.d('clause', { when: c.when.map(w => this.condition(w, true)).join(this.d('and')), what }) : what;
    });
    return [...lines, ...(behavior.complex ? [this.d('complexTip')] : [])].join(this.d('sep'));
  }

  /** An operation in a few words (no number), for the hover line. */
  private opWord(op: BehaviorOp): string {
    switch (op.kind) {
      case 'add': return this.d(op.amount.value > 0 ? 'op.addMore' : 'op.addLess', { name: this.name(op.channel) });
      case 'scale': return this.d(op.factor.value > 1 ? 'op.scaleUp' : 'op.scaleDown', { name: this.name(op.channel) });
      case 'clear': return this.d('op.clear', { name: this.name(op.channel) });
      case 'convert': return this.d('op.convert', { from: this.name(op.from), to: this.name(op.to) });
      case 'steps': return this.d('op.steps');
      case 'xSteps': return this.d('op.xSteps');
      case 'turn': return this.d('op.turn');
      case 'store': return this.d('op.store', { name: this.name(op.from) });
      case 'release': return this.d('op.release');
      case 'relay': return op.ops.length ? this.d('op.relay', { what: op.ops.map(o => this.opWord(o)).join(this.d('join')) }) : this.d('op.echo');
    }
  }

  /** Why an amount moves, as a hint. */
  private varies(by: VaryBy | undefined): string {
    if (!by) return '';
    return (CHANNEL_KEY as Record<string, string>)[by] ? this.d('varies.channel', { name: this.name(by as ChannelName) }) : this.d(`varies.${by}`);
  }

  /** One operation as a detail bubble: its words, strokes for an add, its number (exact only) and its hint. */
  private opTok(op: BehaviorOp): Tok {
    const label = this.opWord(op);
    switch (op.kind) {
      case 'add': {
        const v = op.amount.value;
        const tipKey = op.channel === 'drag' && v < 0 ? 'tip.dragLess' : op.channel === 'push' && v < 0 ? 'tip.pushLess' : '';
        return { mark: CHANNEL_MARK[op.channel], color: colorOf(op.channel), label, strength: addStrength(v),
          tip: [tipKey ? this.d(tipKey) : this.k(`fx.means.${op.channel}`), this.varies(op.amount.varies)].filter(Boolean).join(' '),
          ...(this.exact ? { num: `${moves(op.amount) ? '~' : ''}${this.signed(v)}` } : {}) };
      }
      case 'scale':
        return { mark: CHANNEL_MARK[op.channel], color: colorOf(op.channel), label, tip: [this.d('tip.scale'), this.varies(op.factor.varies)].filter(Boolean).join(' '),
          ...(this.exact ? { num: `×${this.num(op.factor.value)}` } : {}) };
      case 'clear': return { mark: CHANNEL_MARK[op.channel], color: colorOf(op.channel), label, tip: this.d('tip.clear') };
      case 'convert': {
        const parts = [op.share ? this.d(`share.${op.share}`) : op.amount ? this.num(op.amount.value) : '', op.cap !== undefined ? this.d('share.cap', { n: this.num(op.cap) }) : ''].filter(Boolean);
        return { mark: CHANNEL_MARK[op.to], color: colorOf(op.to), label, tip: this.d('tip.convert'), ...(this.exact && parts.length ? { num: parts.join(' · ') } : {}) };
      }
      case 'steps': return { mark: 'route', color: MARK_COLOR.route, label, tip: this.k('fx.means.steps'), ...(this.exact ? { num: `+${this.num(op.amount.value)}` } : {}) };
      case 'xSteps': return { mark: 'route', color: MARK_COLOR.route, label, tip: this.k('fx.means.steps'), ...(this.exact ? { num: `×${this.num(op.factor.value)}` } : {}) };
      case 'turn': return { mark: 'route', color: MARK_COLOR.route, label, tip: this.k('fx.means.turn') };
      case 'store': return { mark: 'store', color: MARK_COLOR.store, label, tip: this.k('fx.means.store'), ...(this.exact ? { num: this.num(op.amount.value) } : {}) };
      case 'release': return { mark: 'store', color: MARK_COLOR.store, label, tip: this.k('fx.means.release') };
      case 'relay': return { label, tip: this.k(op.ops.length ? 'fx.means.relay' : 'fx.means.echo') };
    }
  }

  /** The details' effect block: each clause with its conditions in words and its operations as bubbles. */
  clauses(behavior: CardBehavior): DetailClause[] {
    return behavior.clauses.map((c: BehaviorClause) => ({
      when: c.when.map(w => this.condition(w, true)).join(this.d('and')),
      toks: c.ops.map(op => this.opTok(op)),
    }));
  }

  /** How it grows, as one sentence with bubbles, then what is special about it. */
  growth(g: GrowthView): Seg[] {
    const segs: Seg[] = [{ text: this.k(`grow.when.${g.on}`, { n: g.every, max: g.max }) }];
    const add = g.add.flatMap((p, i) => [...(i ? [{ text: this.k('grow.join') }] : []), ...this.phrase(p, 'add', g.level)]);
    const burst = g.burst.flatMap((p, i) => [...(i ? [{ text: this.k('grow.join') }] : []), ...this.phrase(p, 'once', g.level)]);
    if (add.length) segs.push({ text: this.k('grow.addLead') }, ...add);
    if (burst.length) {
      if (add.length) segs.push({ text: this.k('grow.burstJoin') });
      segs.push(...(g.on === 'trigger' ? [{ text: this.k('grow.burstTrigger') }] : this.fill('grow.burstRound', { a: this.concept('depart') })), ...burst);
    }
    if (add.length || burst.length) segs.push({ text: this.k('grow.end') });
    if (g.readsLevel) segs.push({ text: this.k('grow.readsLevel') });
    else if (!add.length && !burst.length) segs.push({ text: this.k('grow.nothing') });
    return segs;
  }

  /** The level bubble and the line to the next level. */
  level(g: GrowthView): { tok: Tok; next: string; fill: number } {
    return {
      tok: { label: this.exact ? this.k('grow.levelMax', { level: g.level, max: g.max }) : this.k('grow.level', { level: g.level }), tip: this.k('fx.means.level'), color: 'var(--ch-chance)' },
      next: g.toNext ? this.k(`grow.next.${g.on}`, { n: g.toNext, level: g.level + 1 }) : this.k('grow.atMax'),
      fill: g.toNext ? g.progress / g.every : 1,
    };
  }

  /** What the card brought this trip (exact only): each quantity it moved, what it stored or let out, a route change. */
  trip(receipt: CardTripReceipt): Tok[] | null {
    if (!receipt.activations) return null;
    const toks: Tok[] = [];
    for (const [id, change] of Object.entries(receipt.shuttleChanges)) {
      const ch = CHANNEL_OF_ID[id];
      if (ch && Math.abs(change) >= 0.005) toks.push(this.channel(ch, this.signed(change)));
    }
    if (receipt.stored > 0.005) toks.push(this.concept('store', `+${this.num(receipt.stored)}`));
    if (receipt.released > 0.005) toks.push(this.concept('release', this.num(receipt.released)));
    if (receipt.otherEffects.includes('route')) toks.push({ mark: 'route', color: MARK_COLOR.route, label: this.k('fx.mark.route'), tip: this.k('fx.means.route') });
    return toks;
  }

  /** One phrase of a growth add (per level) or burst (once), from its template. */
  phrase(p: ReturnPhrase, mode: 'add' | 'once', level: number): Seg[] {
    // Per level a multiplier is said by how much it rises; once, by what it multiplies.
    const per = (value: number, factor = false) => (mode === 'add' ? this.k('grow.perLevel', { n: this.signed(value) }) : factor ? `×${this.num(value)}` : this.signed(value));
    const now = (value: number, factor = false) => (mode === 'add' && level > 0 && this.exact
      ? this.k(factor ? 'grow.nowFactorTip' : 'grow.nowTip', { level, n: this.signed(value * level) }) : undefined);
    const key = (name: string) => `grow.${mode}.${name}`;
    switch (p.kind) {
      case 'amount':
        return this.fill(key(p.value >= 0 ? 'amountMore' : 'amountLess'), { a: this.channel(p.channel, per(p.value), now(p.value)) });
      case 'factor':
        return mode === 'add'
          ? this.fill(key(p.value >= 0 ? 'factorMore' : 'factorLess'), { a: this.channel(p.channel, per(p.value, true), now(p.value, true)) })
          : this.fill(key('factor'), { a: this.channel(p.channel, per(p.value, true)) });
      case 'convert':
        return p.from && p.to
          ? this.fill(key('convert'), { a: this.channel(p.from, per(p.amount)), b: this.channel(p.to) })
          : this.fill(key('convertOwn'), { a: this.concept('convert', per(p.amount)) });
      case 'steps': return this.fill(key(mode === 'add' && p.value < 0 ? 'stepsLess' : 'steps'), { a: this.concept('step', per(p.value)) });
      case 'xSteps': return this.fill(key(mode === 'add' && p.value < 0 ? 'xStepsLess' : 'xSteps'), { a: this.concept('step', per(p.value, true)) });
      // A switch in a growth add turns on from a level on (card-describe `switchFrom`).
      case 'turn': return this.fill(key('turn'), { a: this.concept('turn') }, { level: p.fromLevel ?? 1 });
      case 'store': return this.fill(key('store'), { a: this.concept('store', per(p.amount)) });
      case 'release': return this.fill(key('release'), { a: this.concept('release') }, { level: p.fromLevel ?? 1 });
      case 'echo': return this.fill(key('echo'), { a: this.concept('echo') }, { level: p.fromLevel ?? 1 });
      case 'relay': {
        const inner = p.parts.flatMap((part, i) => [...(i ? [{ text: this.k('grow.join') }] : []), ...this.phrase(part, mode, level)]);
        return [...this.fill(key('relay'), { a: this.concept('relay') }), ...inner];
      }
      default:
        // A change the words cannot say (or a phrase this version does not know): say that something changes.
        return [{ text: this.k('grow.other') }];
    }
  }

  /** A template with `{a}` / `{b}` bubbles in it (and plain `params`), as text and bubbles in order. */
  private fill(key: string, toks: Partial<Record<'a' | 'b', Tok>>, params: Record<string, unknown> = {}): Seg[] {
    const MARK = '\u0001';
    const text = this.k(key, { ...params, a: `${MARK}a${MARK}`, b: `${MARK}b${MARK}` });
    return text.split(new RegExp(`${MARK}(a|b)${MARK}`)).flatMap((part, i): Seg[] => {
      if (i % 2 === 0) return part ? [{ text: part }] : [];
      const tok = toks[part as 'a' | 'b'];
      return tok ? [{ tok }] : [];
    });
  }
}

/** The card words for a component: they follow the interface language and the exact-numbers switch. */
export function useCardWords(exact: () => boolean): ComputedRef<CardWords> {
  const { t, locale } = useI18n();
  return computed(() => new CardWords((key, params) => t(key, params ?? {}), locale.value, exact()));
}
