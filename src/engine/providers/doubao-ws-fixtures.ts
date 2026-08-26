/**
 * TEST FIXTURES for the Doubao V3 WebSocket protocol — server-side frame
 * builders replicating the live wire shapes (2026-08-27) plus a FakeWebSocket
 * for provider tests. Imported ONLY by *.test.ts files; never ship-path code.
 */

export function serverFullFrame(event: number, sessionId: string | null, payload: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const sid = sessionId === null ? null : new TextEncoder().encode(sessionId);
  const out = new Uint8Array(4 + 4 + (sid ? 4 + sid.length : 0) + 4 + json.length);
  const view = new DataView(out.buffer);
  out[0] = 0x11; out[1] = (0b1001 << 4) | 0b0100; out[2] = 0x10;
  let off = 4;
  view.setInt32(off, event, false); off += 4;
  if (sid) { view.setUint32(off, sid.length, false); off += 4; out.set(sid, off); off += sid.length; }
  view.setUint32(off, json.length, false); off += 4;
  out.set(json, off);
  return out;
}

/**
 * Audio frame. Both live-captured shapes (2026-08-27):
 * - query-auth mode (production/browser): event int 352 precedes the session
 *   id (`withEvent: true`, default) — serialization byte 0x00;
 * - header-auth mode: NO event int, session id length comes first.
 */
export function serverAudioFrame(sessionId: string, audio: Uint8Array, withEvent = true): Uint8Array {
  const sid = new TextEncoder().encode(sessionId);
  const out = new Uint8Array(4 + (withEvent ? 4 : 0) + 4 + sid.length + 4 + audio.length);
  const view = new DataView(out.buffer);
  out[0] = 0x11; out[1] = (0b1011 << 4) | 0b0100; out[2] = withEvent ? 0x00 : 0x10;
  let off = 4;
  if (withEvent) { view.setInt32(off, 352, false); off += 4; }
  view.setUint32(off, sid.length, false); off += 4;
  out.set(sid, off); off += sid.length;
  view.setUint32(off, audio.length, false); off += 4;
  out.set(audio, off);
  return out;
}

export function serverErrorFrame(code: number, message: string): Uint8Array {
  const msg = new TextEncoder().encode(message);
  const out = new Uint8Array(4 + 4 + 4 + msg.length);
  const view = new DataView(out.buffer);
  out[0] = 0x11; out[1] = 0b1111 << 4; out[2] = 0x10;
  view.setUint32(4, code, false);
  view.setUint32(8, msg.length, false);
  out.set(msg, 12);
  return out;
}

/** Sequence-flagged full response (sauc/STT); lastFlag sets bit 0b0010. */
export function serverSeqFrame(seq: number, payload: unknown, lastFlag = false): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const out = new Uint8Array(4 + 4 + 4 + json.length);
  const view = new DataView(out.buffer);
  out[0] = 0x11; out[1] = (0b1001 << 4) | (lastFlag ? 0b0011 : 0b0001); out[2] = 0x10;
  view.setInt32(4, seq, false);
  view.setUint32(8, json.length, false);
  out.set(json, 12);
  return out;
}

/**
 * Minimal browser-shaped WebSocket double. Tests drive it manually:
 * `open()` fires onopen, `emitFrame()` delivers a binary server frame,
 * `emitError()` / `emitClose()` fire the respective handlers.
 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void { FakeWebSocket.instances = []; }

  url: string;
  binaryType = 'blob';
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((evt: MessageEvent) => void) | null = null;
  onerror: ((evt: unknown) => void) | null = null;
  onclose: ((evt: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: ArrayBuffer | Uint8Array): void {
    this.sent.push(data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data));
  }

  close(): void { this.closed = true; }

  open(): void { this.onopen?.(); }
  emitFrame(frame: Uint8Array): void {
    const buf = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
    this.onmessage?.({ data: buf } as MessageEvent);
  }
  emitError(): void { this.onerror?.({}); }
  emitClose(): void { this.onclose?.({}); }

  /** Decode the JSON payload of a captured full-client frame. */
  static decodeClientJson(frame: Uint8Array): { sequence?: number; payload: unknown } {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const hasSeq = (frame[1] & 0x0f) !== 0;
    let off = 4;
    let sequence: number | undefined;
    if (hasSeq) { sequence = view.getInt32(off, false); off += 4; }
    const len = view.getUint32(off, false); off += 4;
    return { sequence, payload: JSON.parse(new TextDecoder().decode(frame.subarray(off, off + len))) };
  }
}
