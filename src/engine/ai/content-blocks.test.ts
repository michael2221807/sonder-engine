import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  IMAGE_BLOCK_TOKEN_BUDGET,
  isBlockContent,
  messageHasImageBlocks,
  messagesHaveImageBlocks,
  contentToText,
  contentToDebugText,
} from './content-blocks';
import { OpenAIProvider } from './providers/openai-provider';
import { ClaudeProvider } from './providers/claude-provider';
import { GeminiProvider } from './providers/gemini-provider';
import { estimateMessagesTokens } from '../core/metrics-helpers';
import { applyStrictMessageFormat } from './ai-service';
import { stripTagFromMessages } from '../memory/snapshot-sanitizer';
import type { AIContentBlock, AIMessage, APIConfig } from './types';

const PNG_DATA_URL = `data:image/png;base64,${'A'.repeat(4000)}`;

function blocks(...items: AIContentBlock[]): AIContentBlock[] {
  return items;
}

function imageMessage(): AIMessage {
  return {
    role: 'user',
    content: blocks(
      { type: 'image', dataUrl: PNG_DATA_URL },
      { type: 'text', text: 'describe this image' },
    ),
  };
}

function makeConfig(provider: APIConfig['provider']): APIConfig {
  return {
    id: 'test', name: 'test', provider,
    url: 'https://example.test', apiKey: 'k', model: 'test-model',
    temperature: 0.7, maxTokens: 1000, enabled: true,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('content-blocks helpers', () => {
  it('isBlockContent distinguishes string from block arrays', () => {
    expect(isBlockContent('plain')).toBe(false);
    expect(isBlockContent(blocks({ type: 'text', text: 'x' }))).toBe(true);
  });

  it('messageHasImageBlocks / messagesHaveImageBlocks detect image blocks only', () => {
    const textOnly: AIMessage = { role: 'user', content: blocks({ type: 'text', text: 'x' }) };
    const plain: AIMessage = { role: 'user', content: 'x' };
    expect(messageHasImageBlocks(textOnly)).toBe(false);
    expect(messageHasImageBlocks(plain)).toBe(false);
    expect(messageHasImageBlocks(imageMessage())).toBe(true);
    expect(messagesHaveImageBlocks([plain, textOnly])).toBe(false);
    expect(messagesHaveImageBlocks([plain, imageMessage()])).toBe(true);
  });

  it('contentToText joins text blocks and drops image blocks', () => {
    expect(contentToText('as-is')).toBe('as-is');
    expect(contentToText(imageMessage().content)).toBe('describe this image');
    expect(contentToText(blocks(
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ))).toBe('a\nb');
  });

  it('contentToDebugText renders image blocks as a placeholder without base64', () => {
    const out = contentToDebugText(imageMessage().content);
    expect(out).toContain('[图片 image/png');
    expect(out).toContain('describe this image');
    expect(out).not.toContain('AAAA');
  });
});

describe('estimateMessagesTokens with image blocks', () => {
  it('counts image blocks at the fixed budget, not base64 length', () => {
    const withImage = estimateMessagesTokens([imageMessage()]);
    const textOnly = estimateMessagesTokens([
      { content: 'describe this image' },
    ]);
    // image budget dominates; base64 length (4000 chars ≈ 1000 text tokens) must not leak in
    expect(withImage).toBe(textOnly + IMAGE_BLOCK_TOKEN_BUDGET);
  });
});

describe('OpenAIProvider multimodal wire format', () => {
  it('serializes image blocks as snake_case image_url and keeps string content verbatim', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }),
    );
    const provider = new OpenAIProvider(makeConfig('custom'));
    await provider.generate({
      messages: [
        { role: 'system', content: 'sys prompt' },
        imageMessage(),
      ],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0]).toEqual({ role: 'system', content: 'sys prompt' });
    expect(body.messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      { type: 'text', text: 'describe this image' },
    ]);
  });
});

describe('OpenAIProvider streaming multimodal wire format', () => {
  it('streaming request body serializes image blocks identically to non-streaming', async () => {
    // 非 SSE content-type → 触发降级路径，但第一个（流式）请求体已可断言
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const provider = new OpenAIProvider(makeConfig('custom'));
    await provider.generate({ messages: [imageMessage()], stream: true });
    const streamBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(streamBody.stream).toBe(true);
    expect(streamBody.messages[0].content).toEqual([
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      { type: 'text', text: 'describe this image' },
    ]);
  });
});

describe('applyStrictMessageFormat with block content (design §3.2)', () => {
  it('converts roles without touching block payloads', () => {
    const img = imageMessage();
    const messages: AIMessage[] = [
      { role: 'system', content: 'sys' },
      img,
      { role: 'system', content: '中途 system' },
      { role: 'assistant', content: blocks({ type: 'text', text: 'prefill' }) },
    ];
    const out = applyStrictMessageFormat(messages);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toBe(img.content); // 块数组引用原样保留
    expect(out[2].role).toBe('user');         // 中途 system → user
    expect(out[3].role).toBe('user');         // 末尾 assistant → user
    expect(out[3].content).toEqual(blocks({ type: 'text', text: 'prefill' }));
  });
});

describe('stripTagFromMessages（NSFW 剥离回归 + 块内容分支）', () => {
  const TAG = '私密';

  it('plain-string 剥离行为不变，未命中消息保持原引用', () => {
    const hit = { role: 'system', content: '前文[私密]秘密内容[/私密]后文' };
    const miss = { role: 'user', content: '干净内容' };
    const out = stripTagFromMessages([hit, miss], TAG);
    expect(out[0].content).toBe('前文后文');
    expect(out[1]).toBe(miss); // 引用相等
  });

  it('块内容：text 块被剥离，image 块逐字节原样保留', () => {
    const imageBlock = { type: 'image' as const, dataUrl: PNG_DATA_URL };
    const msg = {
      role: 'user',
      content: [
        imageBlock,
        { type: 'text' as const, text: 'A[私密]X[/私密]B' },
      ],
    };
    const out = stripTagFromMessages([msg], TAG);
    const content = out[0].content as AIContentBlock[];
    expect(content[0]).toBe(imageBlock); // image 块引用相等
    expect(content[1]).toEqual({ type: 'text', text: 'AB' });
  });

  it('块内容无命中时消息保持原引用', () => {
    const msg = {
      role: 'user',
      content: [{ type: 'text' as const, text: '干净' }],
    };
    expect(stripTagFromMessages([msg], TAG)[0]).toBe(msg);
  });
});

describe('Claude/Gemini providers reject image blocks (epic D7)', () => {
  it('ClaudeProvider throws a clear error on image blocks', async () => {
    const provider = new ClaudeProvider(makeConfig('claude'));
    await expect(provider.generate({ messages: [imageMessage()] }))
      .rejects.toThrow(/仅支持 OpenAI 兼容/);
  });

  it('GeminiProvider throws a clear error on image blocks', async () => {
    const provider = new GeminiProvider(makeConfig('gemini'));
    await expect(provider.generate({ messages: [imageMessage()] }))
      .rejects.toThrow(/仅支持 OpenAI 兼容/);
  });

  it('ClaudeProvider still accepts text-only block content by flattening it', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [{ text: 'ok' }] }), { status: 200 }),
    );
    const provider = new ClaudeProvider(makeConfig('claude'));
    await provider.generate({
      messages: [{ role: 'user', content: blocks({ type: 'text', text: 'hello' }) }],
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0].content).toBe('hello');
  });
});
