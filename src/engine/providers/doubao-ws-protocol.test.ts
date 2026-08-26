import { describe, it, expect } from 'vitest';
import {
  buildFullClientFrame,
  buildAudioClientFrame,
  parseServerFrame,
  toWebSocketUrl,
  DOUBAO_WS_EVENT,
} from './doubao-ws-protocol';

import {
  serverFullFrame,
  serverAudioFrame,
  serverErrorFrame,
  serverSeqFrame,
} from './doubao-ws-fixtures';

const SID = '3a363ef7-4937-4295-9cd1-a6c7344a1328';

describe('client frame builders', () => {
  it('full client frame without sequence (TTS single-shot)', () => {
    const f = buildFullClientFrame({ a: 1 });
    expect([f[0], f[1], f[2], f[3]]).toEqual([0x11, 0x10, 0x10, 0x00]);
    const len = new DataView(f.buffer).getUint32(4, false);
    expect(JSON.parse(new TextDecoder().decode(f.subarray(8, 8 + len)))).toEqual({ a: 1 });
  });

  it('full client frame with sequence 1 (STT opener)', () => {
    const f = buildFullClientFrame({ b: 2 }, 1);
    expect(f[1]).toBe(0x11);
    expect(new DataView(f.buffer).getInt32(4, false)).toBe(1);
  });

  it('audio client frames carry sequence, last one negated with the last flag', () => {
    const mid = buildAudioClientFrame(new Uint8Array([1, 2, 3]), 4, false);
    expect(mid[1]).toBe(0x21);
    expect(new DataView(mid.buffer).getInt32(4, false)).toBe(4);
    expect(new DataView(mid.buffer).getUint32(8, false)).toBe(3);
    const last = buildAudioClientFrame(new Uint8Array([9]), 5, true);
    expect(last[1]).toBe(0x23);
    expect(new DataView(last.buffer).getInt32(4, false)).toBe(-5);
  });
});

describe('parseServerFrame (live wire shapes 2026-08-27)', () => {
  it('parses a full response with event + session id (TTS SessionFinished)', () => {
    const f = parseServerFrame(serverFullFrame(DOUBAO_WS_EVENT.SessionFinished, SID, {}));
    expect(f?.event).toBe(152);
    expect(f?.sessionId).toBe(SID);
    expect(f?.json).toEqual({});
  });

  it('parses query-auth audio frames (event 352 present — the browser mode)', () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 7, 8, 9]); // "ID3"…
    const f = parseServerFrame(serverAudioFrame(SID, audio, true));
    expect(f?.messageType).toBe(0b1011);
    expect(f?.event).toBe(352);
    expect(f?.sessionId).toBe(SID);
    expect([...(f?.audio ?? [])]).toEqual([...audio]);
  });

  it('parses header-auth audio frames (no event int) without misreading the uuid length', () => {
    // Regression: 36 (uuid length) must not be taken for an event, and 352
    // (event) must not be taken for a length — each misparse silently ate all
    // audio in one of the live probes.
    const audio = new Uint8Array([0x49, 0x44, 0x33, 7, 8, 9]);
    const f = parseServerFrame(serverAudioFrame(SID, audio, false));
    expect(f?.messageType).toBe(0b1011);
    expect(f?.event).toBeUndefined();
    expect(f?.sessionId).toBe(SID);
    expect([...(f?.audio ?? [])]).toEqual([...audio]);
  });

  it('parses the error frame shape (code + message)', () => {
    const f = parseServerFrame(serverErrorFrame(45000000, '{"error":"request does not contain req_params"}'));
    expect(f?.errorCode).toBe(45000000);
    expect(f?.errorMessage).toContain('req_params');
  });

  it('parses sequence-flagged frames (STT) and exposes the last-packet flag', () => {
    const mid = parseServerFrame(serverSeqFrame(3, { result: { text: '' } }));
    expect(mid?.sequence).toBe(3);
    expect((mid!.flags & 0b0010) !== 0).toBe(false);
    const last = parseServerFrame(serverSeqFrame(15, { result: { text: '你好' } }, true));
    expect(last?.sequence).toBe(15);
    expect((last!.flags & 0b0010) !== 0).toBe(true);
  });

  it('returns null on truncated/garbage input instead of throwing', () => {
    expect(parseServerFrame(new Uint8Array([]))).toBeNull();
    expect(parseServerFrame(new Uint8Array([0x11, 0x94, 0x10, 0x00, 0, 0]))).toBeNull();
    const bad = serverAudioFrame(SID, new Uint8Array([1, 2, 3])).slice(0, 20);
    expect(parseServerFrame(bad)).toBeNull();
  });
});

describe('toWebSocketUrl', () => {
  it('maps http(s) schemes onto ws(s)', () => {
    expect(toWebSocketUrl('https://openspeech.bytedance.com')).toBe('wss://openspeech.bytedance.com');
    expect(toWebSocketUrl('http://localhost:8787')).toBe('ws://localhost:8787');
  });
});
