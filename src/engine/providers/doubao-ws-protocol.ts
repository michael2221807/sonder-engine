// App doc: docs/user-guide/pages/game-main.md §3.13 / §3.14 (豆包语音 · WebSocket 协议)
/**
 * Doubao voice (openspeech.bytedance.com) V3 WebSocket binary protocol —
 * frame builders/parsers shared by the TTS and STT providers.
 *
 * Wire format (live-verified 2026-08-27 against the Agent Plan endpoints
 * `/api/v3/plan/tts/unidirectional/stream` and `/api/v3/plan/sauc/*`):
 *
 *   byte0  (protocol version << 4) | header size in 4-byte words → 0x11
 *   byte1  (message type << 4) | flags
 *   byte2  (serialization << 4) | compression → 0x10 (JSON, none)
 *   byte3  reserved
 *
 * Client message types: 0b0001 full request, 0b0010 audio-only.
 * Server message types: 0b1001 full response, 0b1011 audio-only, 0b1111 error.
 * Flags: 0b0001 = carries int32 sequence, 0b0011 = carries NEGATIVE sequence
 * (terminal frame), 0b0100 = carries int32 event (+ session id on session
 * scoped events).
 *
 * Everything here is pure (Uint8Array in/out) so the protocol is unit-testable
 * without a socket.
 */

/** TTS event numbers observed on the unidirectional stream (subset). */
export const DOUBAO_WS_EVENT = {
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
} as const;

const HEADER = { version: 0x11, serializationJson: 0x10 } as const;

function writeInt32BE(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setInt32(offset, value, false);
}

function readInt32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getInt32(offset, false);
}

function readUint32BE(buf: Uint8Array, offset: number): number {
  return new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, false);
}

/**
 * Full client request (JSON payload). With `sequence` set, the frame carries
 * the with-sequence flag (STT opening frame, seq 1); without it the frame is
 * flagless (TTS single-shot request).
 */
export function buildFullClientFrame(payload: unknown, sequence?: number): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const hasSeq = sequence !== undefined;
  const out = new Uint8Array(4 + (hasSeq ? 4 : 0) + 4 + json.length);
  out[0] = HEADER.version;
  out[1] = (0b0001 << 4) | (hasSeq ? 0b0001 : 0);
  out[2] = HEADER.serializationJson;
  let off = 4;
  if (hasSeq) { writeInt32BE(out, off, sequence); off += 4; }
  writeInt32BE(out, off, json.length); off += 4;
  out.set(json, off);
  return out;
}

/**
 * Audio-only client frame (STT upload). `last` flips the negative-sequence
 * flag and negates the sequence — the server treats it as end-of-stream.
 */
export function buildAudioClientFrame(audio: Uint8Array, sequence: number, last: boolean): Uint8Array {
  const out = new Uint8Array(4 + 4 + 4 + audio.length);
  out[0] = HEADER.version;
  out[1] = (0b0010 << 4) | (last ? 0b0011 : 0b0001);
  out[2] = HEADER.serializationJson;
  writeInt32BE(out, 4, last ? -Math.abs(sequence) : sequence);
  writeInt32BE(out, 8, audio.length);
  out.set(audio, 12);
  return out;
}

export interface DoubaoServerFrame {
  /** 9 = full response, 11 = audio-only, 15 = error. */
  messageType: number;
  /** Raw message-type-specific flags (bit 0b0010 marks a terminal frame). */
  flags: number;
  /** Present when the with-event flag is set (full responses only). */
  event?: number;
  /** Session id accompanying session-scoped events / audio frames. */
  sessionId?: string;
  /** Present when a sequence flag is set (STT responses). */
  sequence?: number;
  /** Raw audio payload (audio-only frames). */
  audio?: Uint8Array;
  /** Parsed JSON payload (full responses); undefined when not JSON. */
  json?: unknown;
  /** Error frames: numeric server code + message body. */
  errorCode?: number;
  errorMessage?: string;
}

/** Events that are connection-scoped — no session id precedes their payload. */
const CONNECTION_EVENTS = new Set([1, 2, 50, 51, 52]);

/**
 * Session ids are short strings (uuid = 36 bytes); event numbers of interest
 * start at 350. Values above this threshold at the first slot of an
 * event-flagged AUDIO frame are events, values below are the session id
 * length — see the parse note below.
 */
const AUDIO_EVENT_THRESHOLD = 0xff;

/**
 * Parse one binary server frame. Defensive: returns null on truncated data.
 *
 * ⚠ Live-verified quirk (2026-08-27): full responses (type 9) with the event
 * flag always carry `event` then session id, but AUDIO frames (type 11) are
 * inconsistent ACROSS AUTH MODES — with the resource id sent as an X-Api-*
 * header the server omits the event int (session id length comes first);
 * with the resource id in the query (`api_resource_id=`, the only mode a
 * browser WebSocket can use) the server prepends event 352. Both shapes were
 * captured byte-for-byte; the numeric threshold below disambiguates (uuid
 * length 36 vs event 352). Getting this wrong silently eats every audio
 * frame — it did, twice, in the live probes.
 */
export function parseServerFrame(data: Uint8Array): DoubaoServerFrame | null {
  if (data.length < 4) return null;
  const headerSize = (data[0] & 0x0f) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 0x0f;
  let off = headerSize;
  const frame: DoubaoServerFrame = { messageType, flags };
  try {
    if (messageType === 0b1111) {
      frame.errorCode = readUint32BE(data, off); off += 4;
      const len = readUint32BE(data, off); off += 4;
      if (off + len > data.length) return null;
      frame.errorMessage = new TextDecoder().decode(data.subarray(off, off + len));
      return frame;
    }
    if (flags & 0b0100) {
      if (messageType === 0b1001) {
        frame.event = readInt32BE(data, off); off += 4;
      } else {
        const first = readUint32BE(data, off);
        if (first > AUDIO_EVENT_THRESHOLD) { frame.event = first; off += 4; }
      }
      if (frame.event === undefined || !CONNECTION_EVENTS.has(frame.event)) {
        const sidLen = readUint32BE(data, off); off += 4;
        if (off + sidLen > data.length) return null;
        frame.sessionId = new TextDecoder().decode(data.subarray(off, off + sidLen));
        off += sidLen;
      }
    } else if (flags & 0b0001 || flags & 0b0010 || flags & 0b1000) {
      frame.sequence = readInt32BE(data, off); off += 4;
    }
    const payloadLen = readUint32BE(data, off); off += 4;
    if (off + payloadLen > data.length) return null;
    const payload = data.subarray(off, off + payloadLen);
    if (messageType === 0b1011) {
      frame.audio = payload;
    } else {
      try { frame.json = JSON.parse(new TextDecoder().decode(payload)); } catch { /* non-JSON payload */ }
    }
    return frame;
  } catch {
    return null;
  }
}

/** https→wss / http→ws for a configured HTTP endpoint. */
export function toWebSocketUrl(httpEndpoint: string): string {
  return httpEndpoint.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}
