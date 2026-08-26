import { describe, it, expect, vi, afterEach } from 'vitest';
import { DoubaoSttProvider, parseDoubaoSttResponse, doubaoAudioFormat, DOUBAO_STT_DEFAULT_PATH } from './doubao';

describe('parseDoubaoSttResponse', () => {
  it('reads the documented result.text shape', () => {
    expect(parseDoubaoSttResponse({ result: { text: '你好世界' } })).toBe('你好世界');
  });
  it('falls back to joining utterances', () => {
    expect(parseDoubaoSttResponse({ result: { utterances: [{ text: '你好' }, { text: '世界' }] } })).toBe('你好世界');
  });
  it('accepts a top-level text field and survives garbage', () => {
    expect(parseDoubaoSttResponse({ text: 'hi' })).toBe('hi');
    expect(parseDoubaoSttResponse(null)).toBe('');
    expect(parseDoubaoSttResponse('x')).toBe('');
    expect(parseDoubaoSttResponse({ result: { utterances: [null, { text: 'ok' }] } })).toBe('ok');
  });
});

describe('doubaoAudioFormat', () => {
  it('maps common recorder MIME types', () => {
    expect(doubaoAudioFormat('audio/wav')).toBe('wav');
    expect(doubaoAudioFormat('audio/webm;codecs=opus')).toBe('webm');
    expect(doubaoAudioFormat('audio/ogg')).toBe('ogg');
    expect(doubaoAudioFormat('audio/mpeg')).toBe('mp3');
    expect(doubaoAudioFormat('')).toBe('wav');
  });
});

describe('DoubaoSttProvider request shape', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs flash endpoint with credential headers and base64 audio', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ result: { text: '测试' } }), {
        status: 200, headers: { 'X-Api-Status-Code': '20000000' },
      });
    }));
    const provider = new DoubaoSttProvider('https://openspeech.bytedance.com', '', undefined, {
      appId: 'app1', accessToken: 'tok1', resourceId: 'volc.bigasr.auc_turbo',
    });
    const result = await provider.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }));
    expect(result.text).toBe('测试');
    expect(captured.url).toBe(`https://openspeech.bytedance.com${DOUBAO_STT_DEFAULT_PATH}`);
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['X-Api-App-Key']).toBe('app1');
    expect(headers['X-Api-Access-Key']).toBe('tok1');
    expect(headers['X-Api-Sequence']).toBe('-1');
    const body = JSON.parse(String(captured.init?.body));
    expect(body.audio.format).toBe('wav');
    expect(body.audio.data).toBe(btoa('\x01\x02\x03'));
  });

  it('surfaces the X-Api-Status-Code failure with the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{}', { status: 200, headers: { 'X-Api-Status-Code': '45000001', 'X-Api-Message': 'bad credentials' } })));
    const provider = new DoubaoSttProvider('https://x.test', '');
    await expect(provider.transcribe(new Blob([new Uint8Array([1])], { type: 'audio/wav' })))
      .rejects.toThrow(/45000001.*bad credentials/);
  });
});
