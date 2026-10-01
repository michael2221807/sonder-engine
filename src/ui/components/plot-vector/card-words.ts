/**
 * Words for what a card does and how it grows (PO 2026-10-01; demo docs/demo/plot-vector-effect-and-start.html).
 * The sentences are fixed templates from the i18n glossary; what fills them is engine data — the measured marks,
 * the declared growth read as phrases, the trip's own record. Keywords come as bubbles that explain themselves on
 * hover, and carry their number only when the player asked for exact numbers. Nothing here reads the model's text.
 */
import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import type { CardEffect, EffectMark, GrowthView, ReturnPhrase } from '@/features/plot-vector/card-describe';
import type { CardTripReceipt } from '@/features/plot-vector/card-trip-receipt';
import type { ChannelName } from '@/features/plot-vector/contract/types';
import { CHANNEL_KEY, CHANNEL_MARK, CHANNEL_OF_ID, MARK_COLOR, MARK_GLYPH, signed } from './effect-marks';

export type Translate = (key: string, params?: Record<string, unknown>) => string;
/** A keyword bubble: its mark and colour, its name, strength strokes, its number (exact only) and its hint. */
export interface Tok { mark?: EffectMark; color?: string; label: string; strength?: number; num?: string; tip: string }
export type Seg = { text: string } | { tok: Tok };

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

  /** The marks of the effect block, with their strokes; exact numbers per time it acts. */
  effects(effects: readonly CardEffect[]): Tok[] {
    return effects.map(e => {
      const less = e.less && (e.mark === 'social' || e.mark === 'chance');
      const parts = Object.entries(e.exact).map(([ch, v]) => (e.mark === 'up' || e.mark === 'down')
        ? `${this.k(`channel.${CHANNEL_KEY[ch as ChannelName]}`)} ${this.signed(v)}` : this.signed(v));
      const num = parts.length ? this.k('fx.perAct', { n: parts.join(' · ') }) : undefined;
      const tip = [this.k(`fx.means.${e.mark}${less ? 'Less' : ''}`), e.strength ? this.k(`fx.strength.${e.strength}`) : '', num && this.exact ? this.k('fx.perActTip') : '']
        .filter(Boolean).join(' ');
      return { mark: e.mark, color: MARK_COLOR[e.mark], label: less ? this.k(`fx.less.${e.mark}`) : this.k(`fx.mark.${e.mark}`), strength: e.strength, tip,
        ...(num && this.exact ? { num } : {}) };
    });
  }

  /** The one hover line of the marks on a card face: their names, in order. */
  faceTip(effects: readonly CardEffect[]): string {
    return this.k('fx.faceTip', { marks: effects.map(e => `${MARK_GLYPH[e.mark]} ${e.less ? this.k(`fx.less.${e.mark}`) : this.k(`fx.mark.${e.mark}`)}`).join(' · ') });
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
