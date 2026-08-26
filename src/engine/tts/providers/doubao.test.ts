import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DoubaoTtsProvider, DOUBAO_TTS_DEFAULT_PATH, DOUBAO_SAMPLE_SPEAKERS } from './doubao';
import {
  FakeWebSocket,
  serverFullFrame,
  serverAudioFrame,
  serverErrorFrame,
} from '../../providers/doubao-ws-fixtures';

const SID = '3a363ef7-4937-4295-9cd1-a6c7344a1328';

describe('DoubaoTtsProvider (WebSocket unidirectional stream)', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  function start(credentials?: Record<string, string>, customPath?: string) {
    const provider = new DoubaoTtsProvider('https://openspeech.bytedance.com', 'apikey-1', customPath, credentials ?? { resourceId: 'seed-tts-2.0' });
    const promise = provider.synthesize('你好', { speaker: 'zh_female_vv_uranus_bigtts' });
    // The socket is constructed synchronously inside synthesize().
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    return { provider, promise, ws };
  }

  it('connects with query auth (browser WebSocket cannot set headers — live-verified)', async () => {
    const { promise, ws } = start();
    expect(ws.url).toBe(
      `wss://openspeech.bytedance.com${DOUBAO_TTS_DEFAULT_PATH}?api_key=apikey-1&api_resource_id=seed-tts-2.0`);
    ws.open();
    const { payload } = FakeWebSocket.decodeClientJson(ws.sent[0]);
    expect(payload).toMatchObject({
      req_params: { text: '你好', speaker: 'zh_female_vv_uranus_bigtts', audio_params: { format: 'mp3', sample_rate: 24000 } },
    });
    ws.emitFrame(serverAudioFrame(SID, new Uint8Array([1, 2])));
    ws.emitFrame(serverAudioFrame(SID, new Uint8Array([3])));
    ws.emitFrame(serverFullFrame(152, SID, {}));
    const blob = await promise;
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('audio/mpeg');
  });

  it('defaults the resource id to seed-tts-2.0 when credentials omit it', () => {
    const { ws, promise } = start({});
    expect(ws.url).toContain('api_resource_id=seed-tts-2.0');
    ws.emitFrame(serverErrorFrame(1, 'x'));
    return expect(promise).rejects.toThrow();
  });

  it('honors a custom routing path (non-plan console endpoint)', () => {
    const { ws, promise } = start(undefined, '/api/v3/tts/unidirectional/stream');
    expect(ws.url).toContain('/api/v3/tts/unidirectional/stream?');
    ws.emitFrame(serverErrorFrame(1, 'x'));
    return expect(promise).rejects.toThrow();
  });

  it('surfaces server error frames with code and message', async () => {
    const { promise, ws } = start();
    ws.open();
    ws.emitFrame(serverErrorFrame(55000000, 'resource ID is mismatched with speaker related resource'));
    await expect(promise).rejects.toThrow(/55000000.*mismatched/);
  });

  it('rejects on SessionFinished without any audio (silent-voice guard)', async () => {
    const { promise, ws } = start();
    ws.open();
    ws.emitFrame(serverFullFrame(152, SID, {}));
    await expect(promise).rejects.toThrow(/empty audio/);
  });

  it('rejects when the connection closes before the session finishes', async () => {
    const { promise, ws } = start();
    ws.open();
    ws.emitFrame(serverAudioFrame(SID, new Uint8Array([1])));
    ws.emitClose();
    await expect(promise).rejects.toThrow(/提前关闭/);
  });

  it('getStreamUrl is null (audio arrives over WS frames, not a URL)', () => {
    const provider = new DoubaoTtsProvider('https://x.test', '');
    expect(provider.getStreamUrl()).toBeNull();
  });

  it('sample speakers are the live-verified 2.0 uranus set', async () => {
    const provider = new DoubaoTtsProvider('https://x.test', '');
    const speakers = await provider.listSpeakers();
    expect(speakers.length).toBe(10);
    for (const s of speakers) expect(s.voiceId).toMatch(/_uranus_bigtts$/);
    expect(DOUBAO_SAMPLE_SPEAKERS[0].voiceId).toBe('zh_female_shuangkuaisisi_uranus_bigtts');
  });

  it('testConnection reports server errors instead of throwing', async () => {
    const provider = new DoubaoTtsProvider('https://x.test', 'k');
    const resultPromise = provider.testConnection();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    ws.open();
    ws.emitFrame(serverErrorFrame(45000002, 'auth failed'));
    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('auth failed');
  });
});
