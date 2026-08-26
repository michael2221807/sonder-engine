import { describe, it, expect, vi, afterEach } from 'vitest';
import { blobToWav16kMono, pcm16ToWav, STT_TARGET_SAMPLE_RATE } from './audio-transcode';

/** Minimal WebAudio doubles — the node test env has no real implementation. */
function makeFakes(opts?: { decodeError?: Error; samples?: Float32Array; duration?: number }) {
  const samples = opts?.samples ?? new Float32Array([0, 0.5, -0.5]);
  const decoded = { duration: opts?.duration ?? samples.length / STT_TARGET_SAMPLE_RATE } as AudioBuffer;
  const closeSpy = vi.fn(async () => undefined);
  class FakeAudioContext {
    close = closeSpy;
    async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
      if (opts?.decodeError) throw opts.decodeError;
      return decoded;
    }
  }
  const offlineArgs: number[][] = [];
  class FakeOfflineAudioContext {
    destination = {};
    constructor(channels: number, length: number, sampleRate: number) {
      offlineArgs.push([channels, length, sampleRate]);
    }
    createBufferSource() {
      return { buffer: null as AudioBuffer | null, connect: vi.fn(), start: vi.fn() };
    }
    async startRendering() {
      return { getChannelData: () => samples } as unknown as AudioBuffer;
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext);
  return { closeSpy, offlineArgs };
}

describe('blobToWav16kMono', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('passes WAV blobs through untouched (no WebAudio needed)', async () => {
    const wav = pcm16ToWav(new Int16Array([1, 2, 3]), 16000);
    const buf = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer;
    const out = await blobToWav16kMono(new Blob([buf], { type: 'audio/wav' }));
    expect([...out]).toEqual([...wav]);
  });

  it('decodes + resamples non-WAV blobs into a 16k mono WAV', async () => {
    const { closeSpy, offlineArgs } = makeFakes({ samples: new Float32Array([0, 1, -1]) });
    const out = await blobToWav16kMono(new Blob([new Uint8Array([9, 9, 9]).buffer as ArrayBuffer], { type: 'audio/webm;codecs=opus' }));
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    expect(new TextDecoder().decode(out.subarray(0, 4))).toBe('RIFF');
    expect(view.getUint32(24, true)).toBe(STT_TARGET_SAMPLE_RATE);
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    // Resampler was asked for mono @16k, and the decode context was closed.
    expect(offlineArgs[0][0]).toBe(1);
    expect(offlineArgs[0][2]).toBe(STT_TARGET_SAMPLE_RATE);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('closes the decode context even when decodeAudioData rejects', async () => {
    const { closeSpy } = makeFakes({ decodeError: new Error('EncodingError: corrupt stream') });
    await expect(blobToWav16kMono(new Blob([new Uint8Array([1]).buffer as ArrayBuffer], { type: 'audio/webm' })))
      .rejects.toThrow(/corrupt stream/);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('zero-duration decodes still request a non-zero render length', async () => {
    const { offlineArgs } = makeFakes({ samples: new Float32Array([0]), duration: 0 });
    await blobToWav16kMono(new Blob([new Uint8Array([1]).buffer as ArrayBuffer], { type: 'audio/ogg' }));
    expect(offlineArgs[0][1]).toBeGreaterThanOrEqual(1);
  });

  it('throws a clear error when WebAudio is unavailable (bare node env)', async () => {
    await expect(blobToWav16kMono(new Blob([new Uint8Array([1]).buffer as ArrayBuffer], { type: 'audio/webm' })))
      .rejects.toThrow(/不支持 WebAudio/);
  });
});
