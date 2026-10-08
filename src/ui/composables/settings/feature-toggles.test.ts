import { describe, expect, it } from 'vitest';
import {
  clampCotRingSize, defaultFeatureToggles, lowLoadMaxRequestsFromInput, mergeFeatureTogglesForSave, parseFeatureToggles,
  parseLowLoadSettings, readCotSettings, type FeatureToggles,
} from './feature-toggles';

describe('parseFeatureToggles', () => {
  it('lays the stored toggles over the defaults', () => {
    expect(parseFeatureToggles('{}')).toEqual(defaultFeatureToggles);
    expect(parseFeatureToggles('{"cot":true,"npc_chat":false}')).toEqual({ ...defaultFeatureToggles, cot: true, npc_chat: false });
  });

  it('keeps keys it does not know (APIPanel co-owns the blob)', () => {
    expect(parseFeatureToggles('{"imageGen_novelai":true}')).toEqual({ ...defaultFeatureToggles, imageGen_novelai: true });
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseFeatureToggles('{')).toThrow();
  });
});

describe('mergeFeatureTogglesForSave', () => {
  it('keeps foreign keys on disk and lets the panel win on its own keys', () => {
    const onDisk = JSON.stringify({ cot: true, imageGen_novelai: true, world_builder: false });
    const toggles: FeatureToggles = { ...defaultFeatureToggles, cot: false };
    const merged = JSON.parse(mergeFeatureTogglesForSave(onDisk, toggles)) as Record<string, unknown>;
    expect(merged.imageGen_novelai).toBe(true);
    expect(merged.world_builder).toBe(false);
    expect(merged.cot).toBe(false);
    expect(Object.keys(merged).length).toBe(Object.keys(defaultFeatureToggles).length + 2);
  });

  it('writes the key order the inline code did: disk keys first, then the panel toggles', () => {
    const merged = mergeFeatureTogglesForSave('{"zzz":1}', defaultFeatureToggles);
    expect(merged).toBe(JSON.stringify({ zzz: 1, ...defaultFeatureToggles }));
  });

  it('throws on a corrupt blob so the caller keeps what is on disk', () => {
    expect(() => mergeFeatureTogglesForSave('{', defaultFeatureToggles)).toThrow();
  });
});

describe('readCotSettings', () => {
  const treeOf = (values: Record<string, unknown>) => (path: string): unknown => values[path];

  it('reads the four chain-of-thought values from the state tree', () => {
    expect(readCotSettings(treeOf({
      '系统.设置.cot.enabled': true,
      '系统.设置.cot.judgeEnabled': true,
      '系统.设置.cot.injectStep2': false,
      '系统.设置.cot.reasoningRingSize': 7,
    }))).toEqual({ enabled: true, judgeEnabled: true, injectStep2: false, ringSize: 7 });
  });

  it('defaults: off, off, injecting step 2, ring of 3 (also when the ring size is not a number)', () => {
    expect(readCotSettings(treeOf({}))).toEqual({ enabled: false, judgeEnabled: false, injectStep2: true, ringSize: 3 });
    expect(readCotSettings(treeOf({ '系统.设置.cot.reasoningRingSize': '9', '系统.设置.cot.enabled': 'true' })).ringSize).toBe(3);
    expect(readCotSettings(treeOf({ '系统.设置.cot.enabled': 'true' })).enabled).toBe(false);
  });
});

describe('clampCotRingSize', () => {
  it('keeps the value in 1-10 and uses 3 for anything that is not a number', () => {
    expect(clampCotRingSize('5')).toBe(5);
    expect(clampCotRingSize('0')).toBe(3);
    expect(clampCotRingSize('-2')).toBe(1);
    expect(clampCotRingSize('99')).toBe(10);
    expect(clampCotRingSize('')).toBe(3);
    expect(clampCotRingSize('abc')).toBe(3);
    expect(clampCotRingSize('4.9')).toBe(4);
  });
});

describe('parseLowLoadSettings', () => {
  it('reads the switch and a request cap clamped to 1-10', () => {
    expect(parseLowLoadSettings('{"lowLoadMode":true,"lowLoadMaxRequests":4}')).toEqual({ enabled: true, maxRequests: 4 });
    expect(parseLowLoadSettings('{"lowLoadMode":true,"lowLoadMaxRequests":99}').maxRequests).toBe(10);
    expect(parseLowLoadSettings('{"lowLoadMaxRequests":-5}').maxRequests).toBe(1);
  });

  it('leaves the cap unset when the stored one is not a number, and the switch off unless exactly true', () => {
    expect(parseLowLoadSettings('{"lowLoadMode":"true","lowLoadMaxRequests":"4"}')).toEqual({ enabled: false, maxRequests: undefined });
    expect(parseLowLoadSettings('{}')).toEqual({ enabled: false, maxRequests: undefined });
  });

  it('throws on text that is not JSON', () => {
    expect(() => parseLowLoadSettings('{')).toThrow();
  });
});

describe('lowLoadMaxRequestsFromInput', () => {
  it('accepts whole numbers 1-10 and rejects the rest', () => {
    expect(lowLoadMaxRequestsFromInput('1')).toBe(1);
    expect(lowLoadMaxRequestsFromInput('10')).toBe(10);
    expect(lowLoadMaxRequestsFromInput('3.7')).toBe(3);
    for (const bad of ['0', '11', '-1', '', 'x']) expect(lowLoadMaxRequestsFromInput(bad)).toBeNull();
  });
});
