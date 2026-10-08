import { describe, it, expect } from 'vitest';
import {
  THINKING_TAGS,
  thinkingBlockRe,
  thinkOrThinkingBlockRe,
  thinkingTagOnlyRe,
  extractThinkingBlocks,
  stripThinkingBlocks,
  stripThinkOrThinkingBlocks,
  stripThinkingTagOnly,
} from './thinking-tags';
import { THINKING_TAGS as REEXPORTED_TAGS } from './response-parser';

// The literals below are the ones the call sites used before the helpers existed.
const OLD_V1 = /<(?:think|thinking|reasoning|thought)>([\s\S]*?)<\/(?:think|thinking|reasoning|thought)>/gi;
const OLD_V1_FROM_TAGS = new RegExp(
  String.raw`<(?:${['think', 'thinking', 'reasoning', 'thought'].join('|')})>([\s\S]*?)<\/(?:${['think', 'thinking', 'reasoning', 'thought'].join('|')})>`,
  'gi',
);
const OLD_V2 = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const OLD_V3 = /<thinking>[\s\S]*?<\/thinking>/g;

describe('thinking-tags: patterns equal the old literals', () => {
  it('V1 source and flags', () => {
    expect(thinkingBlockRe().source).toBe(OLD_V1.source);
    expect(thinkingBlockRe().flags).toBe(OLD_V1.flags);
    expect(thinkingBlockRe().source).toBe(OLD_V1_FROM_TAGS.source);
    expect(thinkingBlockRe().flags).toBe(OLD_V1_FROM_TAGS.flags);
  });
  it('V2 source and flags', () => {
    expect(thinkOrThinkingBlockRe().source).toBe(OLD_V2.source);
    expect(thinkOrThinkingBlockRe().flags).toBe(OLD_V2.flags);
  });
  it('V3 source and flags', () => {
    expect(thinkingTagOnlyRe().source).toBe(OLD_V3.source);
    expect(thinkingTagOnlyRe().flags).toBe(OLD_V3.flags);
  });
  it('every call builds a new instance (no shared lastIndex)', () => {
    expect(thinkingBlockRe()).not.toBe(thinkingBlockRe());
    expect(thinkOrThinkingBlockRe()).not.toBe(thinkOrThinkingBlockRe());
    expect(thinkingTagOnlyRe()).not.toBe(thinkingTagOnlyRe());
  });
  it('THINKING_TAGS keeps its list and is still exported from response-parser', () => {
    expect(THINKING_TAGS).toEqual(['think', 'thinking', 'reasoning', 'thought']);
    expect(REEXPORTED_TAGS).toBe(THINKING_TAGS);
  });
});

describe('thinking-tags: behaviour', () => {
  const raw = '<THINK> a </THINK>x<thought>b</thought><thinking>   </thinking>y';
  it('V1 extracts trimmed non-empty blocks, joined by a blank line', () => {
    expect(extractThinkingBlocks(raw)).toBe('a\n\nb');
    expect(extractThinkingBlocks('plain')).toBeUndefined();
  });
  it('V1 extract is repeatable (no lastIndex residue)', () => {
    expect(extractThinkingBlocks(raw)).toBe(extractThinkingBlocks(raw));
  });
  it('V1 strip does not trim', () => {
    expect(stripThinkingBlocks(' <think>a</think> z ')).toBe('  z ');
  });
  it('V2 strips think/thinking only, any case', () => {
    expect(stripThinkOrThinkingBlocks('<Think>a</think>1<thinking>b</THINKING>2<reasoning>c</reasoning>')).toBe('12<reasoning>c</reasoning>');
  });
  it('V3 strips lower-case thinking only', () => {
    expect(stripThinkingTagOnly('<thinking>a</thinking>1<THINKING>b</THINKING><think>c</think>')).toBe('1<THINKING>b</THINKING><think>c</think>');
  });
});
