import { describe, it, expect, vi, afterEach } from 'vitest';
import { DoubaoTtsProvider, parseDoubaoTtsBody, DOUBAO_TTS_DEFAULT_PATH } from './doubao';

function b64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

describe('parseDoubaoTtsBody', () => {
  it('concatenates base64 data frames in order', () => {
    const body = [
      JSON.stringify({ code: 0, data: b64([1, 2]) }),
      JSON.stringify({ code: 0, data: b64([3]) }),
      JSON.stringify({ code: 20000000, message: 'OK' }), // terminal sentinel
    ].join('\n');
    expect([...parseDoubaoTtsBody(body)]).toEqual([1, 2, 3]);
  });

  it('tolerates SSE-style "data:" prefixes, blank lines and malformed lines', () => {
    const body = `\n data: ${JSON.stringify({ code: 0, data: b64([9]) })}\nnot-json\n[DONE]\n`;
    expect([...parseDoubaoTtsBody(body)]).toEqual([9]);
  });

  it('throws on an error frame with the server message', () => {
    const body = JSON.stringify({ code: 45000001, message: 'invalid speaker' });
    expect(() => parseDoubaoTtsBody(body)).toThrow(/invalid speaker/);
  });

  it('skips frames whose data is not valid base64', () => {
    const body = JSON.stringify({ code: 0, data: '###not-base64###' });
    expect(parseDoubaoTtsBody(body).length).toBe(0);
  });
});

describe('DoubaoTtsProvider request shape', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs the V3 unidirectional endpoint with the three credential headers', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ code: 0, data: b64([1]) }), { status: 200 });
    }));
    const provider = new DoubaoTtsProvider('https://openspeech.bytedance.com', '', undefined, {
      appId: 'app1', accessToken: 'tok1', resourceId: 'volc.service_type.10029',
    });
    const blob = await provider.synthesize('你好', { speaker: 'zh_female_cancan_mars_bigtts' });
    expect(blob.size).toBe(1);
    expect(captured.url).toBe(`https://openspeech.bytedance.com${DOUBAO_TTS_DEFAULT_PATH}`);
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers['X-Api-App-Key']).toBe('app1');
    expect(headers['X-Api-Access-Key']).toBe('tok1');
    expect(headers['X-Api-Resource-Id']).toBe('volc.service_type.10029');
    expect(headers['X-Api-Request-Id']).toBeTruthy();
    const body = JSON.parse(String(captured.init?.body));
    expect(body.req_params.text).toBe('你好');
    expect(body.req_params.speaker).toBe('zh_female_cancan_mars_bigtts');
  });

  it('getStreamUrl is null (POST + header auth cannot feed <audio>)', () => {
    const provider = new DoubaoTtsProvider('https://x.test', '');
    expect(provider.getStreamUrl()).toBeNull();
  });

  it('testConnection reports the server error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ code: 45000002, message: 'auth failed' }), { status: 200 })));
    const provider = new DoubaoTtsProvider('https://x.test', '');
    const result = await provider.testConnection();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('auth failed');
  });
});
