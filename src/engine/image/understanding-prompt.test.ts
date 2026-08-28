import { describe, it, expect } from 'vitest';
import {
  buildUnderstandingPrompt,
  parseUnderstandingResponse,
  looksLikeRefusal,
  minPromptTokensWithImage,
} from './understanding-prompt';

describe('buildUnderstandingPrompt', () => {
  it('tags mode asks only for tags', () => {
    const { taskText } = buildUnderstandingPrompt('tags');
    expect(taskText).toContain('"tags"');
    expect(taskText).not.toContain('"caption"');
  });

  it('caption mode asks only for caption', () => {
    const { taskText } = buildUnderstandingPrompt('caption');
    expect(taskText).toContain('"caption"');
    expect(taskText).not.toContain('"tags"');
  });

  it('both mode asks for two fields', () => {
    const { taskText, system } = buildUnderstandingPrompt('both');
    expect(taskText).toContain('"tags"');
    expect(taskText).toContain('"caption"');
    expect(system).toContain('STRICT JSON');
  });

  it('appends user extra prompt when provided', () => {
    const { taskText } = buildUnderstandingPrompt('both', '  重点关注服装细节  ');
    expect(taskText).toContain('重点关注服装细节');
    expect(buildUnderstandingPrompt('both', '   ').taskText).not.toContain('Additional requirements');
  });
});

describe('parseUnderstandingResponse', () => {
  const BOTH = '{"tags":["1girl","solo"],"caption":"A girl."}';

  it('parses bare JSON for both', () => {
    const r = parseUnderstandingResponse(BOTH, 'both');
    expect(r.degraded).toBe(false);
    expect(r.tags).toEqual([{ text: '1girl' }, { text: 'solo' }]);
    expect(r.caption).toBe('A girl.');
    expect(r.positiveDraft).toBe('1girl, solo, A girl.');
  });

  it('parses fenced JSON and per-task drafts', () => {
    const fenced = '```json\n' + BOTH + '\n```';
    expect(parseUnderstandingResponse(fenced, 'tags').positiveDraft).toBe('1girl, solo');
    expect(parseUnderstandingResponse(fenced, 'caption').positiveDraft).toBe('A girl.');
  });

  it('filters non-string and empty tags, trims entries', () => {
    const r = parseUnderstandingResponse('{"tags":["ok ", "", 42, null], "caption":" c "}', 'both');
    expect(r.tags).toEqual([{ text: 'ok' }]);
    expect(r.caption).toBe('c');
  });

  it('degrades non-JSON to caption', () => {
    const r = parseUnderstandingResponse('A plain sentence about the image.', 'both');
    expect(r.degraded).toBe(true);
    expect(r.caption).toBe('A plain sentence about the image.');
    expect(r.positiveDraft).toBe('A plain sentence about the image.');
    expect(r.tags).toBeUndefined();
  });

  it('degrades JSON arrays / primitives to caption', () => {
    expect(parseUnderstandingResponse('["a","b"]', 'both').degraded).toBe(true);
    expect(parseUnderstandingResponse('42', 'both').degraded).toBe(true);
  });

  it('handles missing fields without throwing', () => {
    const r = parseUnderstandingResponse('{"tags":[]}', 'both');
    expect(r.degraded).toBe(false);
    expect(r.tags).toBeUndefined();
    expect(r.positiveDraft).toBe('');
  });
});

describe('looksLikeRefusal', () => {
  it('detects common English refusals', () => {
    expect(looksLikeRefusal("I can't assist with analyzing this image.")).toBe(true);
    expect(looksLikeRefusal('I am unable to describe this image.')).toBe(true);
    expect(looksLikeRefusal('This goes against my content policy.')).toBe(true);
  });

  it('detects common Chinese refusals', () => {
    expect(looksLikeRefusal('抱歉，我无法分析这张图片。')).toBe(true);
    expect(looksLikeRefusal('该内容违反了使用政策。')).toBe(true);
  });

  it('does not flag normal descriptions or empty text', () => {
    expect(looksLikeRefusal('A girl standing in a garden.')).toBe(false);
    expect(looksLikeRefusal('')).toBe(false);
  });
});

describe('minPromptTokensWithImage（真实校准 2026-08-27）', () => {
  it('returns null for non-openai routes（anthropic 小图 109 tokens 会被任何文本下限误伤）', () => {
    expect(minPromptTokensWithImage('abcd', '', 'anthropic/claude-sonnet-5')).toBeNull();
    expect(minPromptTokensWithImage('abcd', '', 'google/gemini-2.5-flash')).toBeNull();
    expect(minPromptTokensWithImage('abcd', '', '')).toBeNull();
  });

  it('openai/ routes get text estimate + 500 floor（丢图 77 vs 真看图 8550 的鸿沟）', () => {
    const short = minPromptTokensWithImage('abcd', '', 'openai/gpt-4o-mini');
    expect(short).toBe(2 + 500); // '\n' + 4 chars → ceil(5/4)=2，加 openai 图片下限 500
    const { system, taskText } = buildUnderstandingPrompt('both');
    const real = minPromptTokensWithImage(taskText, system, 'openai/gpt-4o');
    expect(real).toBeGreaterThan(500);
    expect(real).toBeLessThan(2000); // 远低于 openai 真实带图 promptTokens（实测 8550）
  });
});
