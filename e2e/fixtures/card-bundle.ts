/**
 * Game-card (.aga-card) bundle decode + secret-leak assertion
 * (extracted from game-card-epic.spec.ts). Reusable for any export/backup spec.
 */
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { expect } from '@playwright/test';

/** The subset of the card bundle our export assertions read. */
interface CardBundle {
  bundleType: string;
  cardMeta: { title: string; packId: string } & Record<string, unknown>;
  engram: { entities: unknown[] } & Record<string, unknown>;
  stateTree?: { 元数据?: { 叙事历史?: unknown[] } & Record<string, unknown> } & Record<string, unknown>;
  [key: string]: unknown;
}

export interface CardEnvelope {
  format: string;
  bundle: CardBundle;
  [key: string]: unknown;
}

/** Decodes a downloaded .aga-card (gzip envelope → JSON). */
export function decodeCardFile(path: string): CardEnvelope {
  return JSON.parse(gunzipSync(readFileSync(path)).toString('utf-8')) as CardEnvelope;
}

/**
 * Hard assertion mirroring Story 5 SC-9: no API-key markers leaked into the bundle.
 * Matches both legacy (`sk-…`) and project-scoped (`sk-proj-…`) key shapes; the 16+
 * key-char tail avoids false positives on innocuous "sk-x" substrings in narrative.
 */
export function assertNoSecrets(bundleJson: string): void {
  expect(bundleJson).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
}
