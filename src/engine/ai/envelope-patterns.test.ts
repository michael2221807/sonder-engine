import { describe, it, expect } from 'vitest';
import { ENVELOPE_HEAD, REPLY_HEAD, STORED_ENVELOPE, RESIDUAL_ESCAPES, ENVELOPE_KEY_HEAD } from './response-parser';
import { PREFIX_RE } from '../pipeline/stages/ai-call';

// The literals below are the ones the four patterns were written as before they shared ENVELOPE_KEY_HEAD.
const OLD_ENVELOPE_HEAD = /^\{\s*"(?:text|叙事文本)"\s*:\s*"/;
const OLD_REPLY_HEAD = /^(?:```(?:json|JSON)?\s*)?\{\s*"(?:text|叙事文本)"\s*:/;
const OLD_STORED_ENVELOPE = /^(?:<正文>\s*)?\{\s*"(?:text|叙事文本)"\s*:/;
const OLD_PREFIX_RE = /^\s*(?:<正文>\s*)?(?:```(?:json|JSON)?\s*)?\{\s*"(?:text|叙事文本)"\s*:\s*"/;

describe('envelope head patterns built from ENVELOPE_KEY_HEAD', () => {
  it.each([
    ['ENVELOPE_HEAD', ENVELOPE_HEAD, OLD_ENVELOPE_HEAD],
    ['REPLY_HEAD', REPLY_HEAD, OLD_REPLY_HEAD],
    ['STORED_ENVELOPE', STORED_ENVELOPE, OLD_STORED_ENVELOPE],
    ['PREFIX_RE (stream unwrapper)', PREFIX_RE, OLD_PREFIX_RE],
  ])('%s keeps the old source and flags', (_name, built, old) => {
    expect(built.source).toBe(old.source);
    expect(built.flags).toBe(old.flags);
  });

  it('the shared key head is the part all four patterns contain', () => {
    expect(ENVELOPE_KEY_HEAD).toBe(String.raw`\{\s*"(?:text|叙事文本)"\s*:`);
  });
});

describe('RESIDUAL_ESCAPES', () => {
  it('is the table the stream unwrapper used as its own ESCAPE_MAP', () => {
    expect(RESIDUAL_ESCAPES).toEqual({ n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' });
    expect(Object.keys(RESIDUAL_ESCAPES)).toEqual(['n', 't', 'r', '"', '\\', '/']);
  });
});
