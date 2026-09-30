/**
 * The round's push in two words (PO 3A): read from the same packet the model got, only for the round it shaped.
 */
import { describe, expect, it } from 'vitest';
import { impulseOf, roundImpulse, IMPULSE_FAINT, IMPULSE_STRONG } from './round-impulse';
import { acceptVector, initialVectorState, prepareVector, type VectorState } from './runtime';
import type { NativeInput } from './native-input';
import type { VectorPacket } from '../../engine/plot-vector/core/types';

const packet = (S: number, Y: number, J: number) => ({ dimensions: { S, Y, J } }) as unknown as VectorPacket;

describe('reading the push', () => {
  it('names the tone from going well to heavy resistance, and the stronger of relations and openings', () => {
    expect(impulseOf(packet(0.3, 0.4, 0.2))).toEqual({ tone: 'with', lean: 'social' });
    expect(impulseOf(packet(0.02, 0.1, 0.3))).toEqual({ tone: 'even', lean: 'chance' });
    expect(impulseOf(packet(-IMPULSE_FAINT, 0.05, 0))).toEqual({ tone: 'against' });
    expect(impulseOf(packet(-IMPULSE_STRONG, 0.2, 0.2))).toEqual({ tone: 'hard', lean: 'social' });
  });
  it('says nothing when every dimension is faint or a value is missing', () => {
    expect(impulseOf(packet(0.05, 0.05, 0.09))).toBeNull();
    expect(impulseOf(packet(Number.NaN, 0.5, 0.5))).toBeNull();
  });
});

describe('the round it belongs to', () => {
  const native: NativeInput = { ruleId: 't', payload: { 'S+': 4, 'S-': 0, Y: 3, J: 1 }, visitBudget: 10, contributions: [] };
  const accepted = (id: string, input: NativeInput = native): VectorState => {
    const state = initialVectorState();
    return acceptVector(state, prepareVector(state, [], id, input));
  };
  it('shows the accepted trip only beside the round it was made for', () => {
    const state = accepted('p/s/12');
    expect(roundImpulse(state, 12)).toEqual(impulseOf(state.last!.result.vectorPacket));
    expect(roundImpulse(state, 12)).not.toBeNull();
    expect(roundImpulse(state, 13)).toBeNull(); // a later round played without momentum
    expect(roundImpulse(state, 2)).toBeNull();  // "/12" must not match round 2
    expect(roundImpulse(undefined, 12)).toBeNull();
  });
  it('shows nothing when the trip gave the model no push', () => {
    const none: NativeInput = { ruleId: 't', payload: { 'S+': 0, 'S-': 0, Y: 0, J: 0 }, visitBudget: 10, contributions: [] };
    expect(roundImpulse(accepted('p/s/5', none), 5)).toBeNull();
  });
});
