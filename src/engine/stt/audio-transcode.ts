/**
 * Recording → WAV transcoding for STT backends that need a fixed PCM input
 * (Doubao sauc wants 16 kHz mono s16le; MediaRecorder emits webm/opus).
 *
 * The WAV encoder is pure (unit-tested); the decode path rides the browser's
 * WebAudio decoder (AudioContext.decodeAudioData handles webm/opus/ogg/wav in
 * every engine this app supports) and resamples through an OfflineAudioContext.
 */

export const STT_TARGET_SAMPLE_RATE = 16_000;

/** Wrap little-endian PCM16 samples in a minimal RIFF/WAVE container. */
export function pcm16ToWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const dataLen = samples.length * 2;
  const out = new Uint8Array(44 + dataLen);
  const view = new DataView(out.buffer);
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);            // PCM
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data'); view.setUint32(40, dataLen, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true);
  return out;
}

/** Float [-1,1] → clamped s16. Pure for tests. */
export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

interface AudioContextLike {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  close(): Promise<void>;
}
type AudioContextCtor = new () => AudioContextLike;
type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/**
 * Decode any browser-supported recording blob and resample to 16 kHz mono
 * PCM16 WAV. Blobs that are already WAV pass through untouched (they carry
 * their own header; the server reads it).
 */
export async function blobToWav16kMono(blob: Blob): Promise<Uint8Array> {
  if (/wav/i.test(blob.type)) {
    return new Uint8Array(await blob.arrayBuffer());
  }
  const g = globalThis as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor; OfflineAudioContext?: OfflineCtor };
  const AC = g.AudioContext ?? g.webkitAudioContext;
  const Offline = g.OfflineAudioContext;
  if (!AC || !Offline) throw new Error('[STT] 当前环境不支持 WebAudio 解码（无法转换录音格式）');
  const ctx = new AC();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  } finally {
    void ctx.close().catch(() => { /* ignore */ });
  }
  const length = Math.max(1, Math.ceil(decoded.duration * STT_TARGET_SAMPLE_RATE));
  const offline = new Offline(1, length, STT_TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return pcm16ToWav(floatTo16BitPcm(rendered.getChannelData(0)), STT_TARGET_SAMPLE_RATE);
}
