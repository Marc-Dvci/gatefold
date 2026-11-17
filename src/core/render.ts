/**
 * From circuit outputs to sound: render beats, turn them into 16-bit PCM and write WAV files.
 */
import { type Engine, flatten, makeEngine, simplify } from "./flat";
import type { CompiledSong } from "./song";
import { BEAT_RATE } from "./instruments";

/** Default pins: full intensity, normal tempo. */
export const FULL = new Uint8Array([1, 1, 0]);

export function songEngine(cs: CompiledSong): Engine {
  return makeEngine(simplify(flatten(cs.circuit)));
}

/** Run `beats` beats of a song from the all-zero state and return the raw output words. */
export function renderBeats(cs: CompiledSong, beats: number, pins: Uint8Array = FULL): Int32Array {
  const e = songEngine(cs);
  const out = new Int32Array(beats);
  e.run(beats, pins, out);
  return out;
}

/** Map raw mixer words (0 .. 15 x channels) to 16-bit PCM around zero, with headroom. */
export function toPcm16(raw: Int32Array, channels: number): Int16Array {
  const full = 15 * channels;
  const mid = full / 2;
  const gain = (0.9 * 32767) / mid;
  const pcm = new Int16Array(raw.length);
  // A first-order DC blocker keeps silence at zero when only some channels play.
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < raw.length; i++) {
    const x = (raw[i]! - mid) * gain;
    const y = x - x1 + 0.9995 * y1;
    x1 = x;
    y1 = y;
    pcm[i] = Math.max(-32767, Math.min(32767, Math.round(y)));
  }
  return pcm;
}

/** A mono 16-bit WAV file. */
export function wav(pcm: Int16Array, rate = BEAT_RATE): Uint8Array {
  const data = pcm.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const text = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, data, true);
  new Int16Array(buf, 44).set(pcm);
  return new Uint8Array(buf);
}

/** Bytes of a CD-quality mono WAV (44.1 kHz, 16-bit) of the given length, header included. */
export function cdWavBytes(seconds: number): number {
  return 44 + Math.round(seconds * 44100) * 2;
}
