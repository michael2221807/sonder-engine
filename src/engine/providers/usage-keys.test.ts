import { describe, it, expect } from 'vitest';
import { providerCatalog } from './index';
import { parsePerBackendUsage, perBackendUsageType, type PerBackendUsageKind } from './usage-keys';

const KINDS: readonly PerBackendUsageKind[] = ['image', 'tts', 'stt'];
const LEGACY_PREFIX: Record<PerBackendUsageKind, string> = { image: 'imageGen_', tts: 'ttsGen_', stt: 'sttGen_' };

describe('usage-keys', () => {
  it('every catalog backend: the built key equals the hand-written template key', () => {
    for (const kind of KINDS) {
      const backends = providerCatalog.byCategory(kind);
      expect(backends.length).toBeGreaterThan(0);
      for (const d of backends) {
        expect(perBackendUsageType(kind, d.id)).toBe(`${LEGACY_PREFIX[kind]}${d.id}`);
      }
    }
  });

  it('every catalog backend: build then parse gives back the kind and backend id', () => {
    for (const kind of KINDS) {
      for (const d of providerCatalog.byCategory(kind)) {
        expect(parsePerBackendUsage(perBackendUsageType(kind, d.id))).toEqual({ kind, backend: d.id });
      }
    }
  });

  it('static usage types are not per-backend keys', () => {
    for (const key of ['main', 'imageGeneration', 'imageCharacterTokenizer', 'bodyPolish', 'embedding']) {
      expect(parsePerBackendUsage(key)).toBeNull();
    }
  });

  it('a backend id that itself contains an underscore survives the round trip', () => {
    expect(parsePerBackendUsage(perBackendUsageType('image', 'sd_webui'))).toEqual({ kind: 'image', backend: 'sd_webui' });
  });
});
