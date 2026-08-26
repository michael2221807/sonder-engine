import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DoubaoSttProvider, DOUBAO_STT_DEFAULT_PATH, extractSaucText } from './doubao';
import { pcm16ToWav, floatTo16BitPcm } from '../audio-transcode';
import {
  FakeWebSocket,
  serverSeqFrame,
  serverErrorFrame,
} from '../../providers/doubao-ws-fixtures';

describe('extractSaucText', () => {
  it('reads result.text and falls back to utterances', () => {
    expect(extractSaucText({ result: { text: '你好世界' } })).toBe('你好世界');
    expect(extractSaucText({ result: { utterances: [{ text: '你好' }, { text: '世界' }] } })).toBe('你好世界');
    expect(extractSaucText({ result: { utterances: [null, { text: 'ok' }] } })).toBe('ok');
    expect(extractSaucText(null)).toBe('');
    expect(extractSaucText('x')).toBe('');
  });
});

describe('audio-transcode pure helpers', () => {
  it('pcm16ToWav writes a valid 16k mono RIFF header', () => {
    const wav = pcm16ToWav(new Int16Array([0, 1000, -1000]), 16000);
    const view = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(22, true)).toBe(1);     // mono
    expect(view.getUint32(40, true)).toBe(6);     // data bytes
    expect(view.getInt16(44 + 2, true)).toBe(1000);
  });

  it('floatTo16BitPcm clamps out-of-range samples', () => {
    const out = floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2, 0.5]));
    expect(out[1]).toBe(0x7fff);
    expect(out[2]).toBe(-0x8000);
    expect(out[3]).toBe(0x7fff);
    expect(out[4]).toBe(-0x8000);
  });
});

describe('DoubaoSttProvider (WebSocket sauc)', () => {
  beforeEach(() => {
    FakeWebSocket.reset();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  const wavBlob = () => new Blob([pcm16ToWav(new Int16Array(8000), 16000)], { type: 'audio/wav' });

  async function start(credentials?: Record<string, string>) {
    const provider = new DoubaoSttProvider('https://openspeech.bytedance.com', 'apikey-1', undefined, credentials ?? { resourceId: 'volc.seedasr.sauc.duration' });
    const promise = provider.transcribe(wavBlob());
    // WAV passthrough is async (arrayBuffer) — wait for the socket to appear.
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBeGreaterThan(0); });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    return { provider, promise, ws };
  }

  it('connects with query auth, sends config (seq 1) then audio frames, last one negated', async () => {
    const { promise, ws } = await start();
    expect(ws.url).toBe(
      `wss://openspeech.bytedance.com${DOUBAO_STT_DEFAULT_PATH}?api_key=apikey-1&api_resource_id=volc.seedasr.sauc.duration`);
    ws.open();
    const opener = FakeWebSocket.decodeClientJson(ws.sent[0]);
    expect(opener.sequence).toBe(1);
    expect(opener.payload).toMatchObject({
      audio: { format: 'wav', rate: 16000, bits: 16, channel: 1 },
      request: { model_name: 'bigmodel' },
    });
    expect(ws.sent.length).toBeGreaterThan(1);
    const last = ws.sent[ws.sent.length - 1];
    expect(last[1]).toBe(0x23); // audio frame, negative-sequence terminal flag
    ws.emitFrame(serverSeqFrame(2, { result: { text: '' } }));
    ws.emitFrame(serverSeqFrame(3, { result: { text: '今天天气真不错' } }, true));
    expect((await promise).text).toBe('今天天气真不错');
  });

  it('resolves with the latest text when the server just closes (live behavior)', async () => {
    const { promise, ws } = await start();
    ws.open();
    ws.emitFrame(serverSeqFrame(2, { result: { text: '你好' } }));
    ws.emitClose();
    expect((await promise).text).toBe('你好');
  });

  it('surfaces server error frames', async () => {
    const { promise, ws } = await start();
    ws.open();
    ws.emitFrame(serverErrorFrame(45000010, 'Invalid X-Api-Key'));
    await expect(promise).rejects.toThrow(/45000010.*Invalid/);
  });

  it('defaults the resource id to volc.seedasr.sauc.duration', async () => {
    const { promise, ws } = await start({});
    expect(ws.url).toContain('api_resource_id=volc.seedasr.sauc.duration');
    ws.emitFrame(serverErrorFrame(1, 'x'));
    await expect(promise).rejects.toThrow();
  });

  it('testConnection succeeds on a clean silent round-trip and fails on auth errors', async () => {
    const provider = new DoubaoSttProvider('https://x.test', 'k');
    const okPromise = provider.testConnection();
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBe(1); });
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.emitFrame(serverSeqFrame(2, { result: { text: '' } }, true));
    expect((await okPromise).ok).toBe(true);

    const failPromise = provider.testConnection();
    await vi.waitFor(() => { expect(FakeWebSocket.instances.length).toBe(2); });
    const ws2 = FakeWebSocket.instances[1];
    ws2.open();
    ws2.emitFrame(serverErrorFrame(45000010, 'Invalid X-Api-Key'));
    const fail = await failPromise;
    expect(fail.ok).toBe(false);
    expect(fail.error).toContain('Invalid X-Api-Key');
  });
});
