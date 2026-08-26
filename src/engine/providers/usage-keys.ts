/**
 * Per-backend usage-type key builders — epic P0 item 7.
 *
 * The assignment table's per-backend rows are keyed `imageGen_<id>` /
 * `ttsGen_<id>` / `sttGen_<id>`. Building those keys used to happen via ad-hoc
 * template strings + `as UsageType` casts scattered across ai-service and the
 * stores; this module is the single sanctioned cast site. The compensating
 * guarantee lives in descriptor.test.ts: every key derivable from the catalog
 * is pinned against a hand-declared `UsageType[]` list, so a catalog entry
 * added without its union member fails the suite instead of surfacing as a
 * runtime routing mystery.
 */
import type { UsageType, APICategory } from '../ai/types';

export type PerBackendUsageKind = Extract<APICategory, 'image' | 'tts' | 'stt'>;

const PREFIX: Record<PerBackendUsageKind, string> = {
  image: 'imageGen_',
  tts: 'ttsGen_',
  stt: 'sttGen_',
};

export function perBackendUsageType(kind: PerBackendUsageKind, backendId: string): UsageType {
  return `${PREFIX[kind]}${backendId}` as UsageType;
}
