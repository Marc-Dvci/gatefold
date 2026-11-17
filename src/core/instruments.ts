/**
 * The Gatefold instrument circuits.
 *
 * Every instrument is a stand-alone TapeOut circuit with the same pins (the Gatefold voice interface), so a song can
 * reference any of them with TAP-02 REF and a maker can publish a new one that drops into any song:
 *
 * | Pins (LSB first) | Name  | Meaning                                                                      |
 * |------------------|-------|------------------------------------------------------------------------------|
 * | in 0-13          | inc   | pitch: phase increment per beat (f = inc x beatRate / 2^18)                  |
 * | in 14            | trig  | 1 on the first beat of a note                                                |
 * | in 15            | gate  | 1 while the note sounds                                                      |
 * | in 16            | tick  | envelope clock: 1 on one beat in 256                                         |
 * | in 17-20         | vol   | volume the envelope starts from, 0-15                                        |
 * | in 21-24         | mode  | bits 0-1 tone (instrument-specific), bits 2-3 decay (none, slow, medium, fast) |
 * | out 0-3          | amp   | amplitude, 0-15                                                              |
 *
 * All state starts at zero, as a fresh TAP-02 state vector does.
 */
import { add, decIf, gate, incIf, isZero, muxWord, register, resize, shr, sub, type Word } from "./arith";
import { type BuildResult, Net, type Sig } from "./net";

export const BEAT_RATE = 24000;
export const INC_BITS = 14;
export const ACC_BITS = 18;
export const VOICE_IN = 25;
export const VOICE_OUT = 4;
/** One envelope tick every 2^PRESCALE beats. */
export const PRESCALE = 8;

export interface VoicePins {
  inc: Word;
  trig: Sig;
  gate: Sig;
  tick: Sig;
  vol: Word;
  tone: Word;
  decay: Word;
}

function voicePins(n: Net): VoicePins {
  const inc = n.inputs_(INC_BITS);
  const trig = n.input();
  const g = n.input();
  const tick = n.input();
  const vol = n.inputs_(4);
  const mode = n.inputs_(4);
  return { inc, trig, gate: g, tick, vol, tone: mode.slice(0, 2), decay: mode.slice(2, 4) };
}

/**
 * Volume envelope: loads `vol` on trig, then steps down by one every 1, 2 or 8 ticks (decay fast, medium, slow),
 * or holds (decay none).
 */
export function envelope(n: Net, p: VoicePins): Word {
  const prev = n.region;
  n.region = "envelope";
  const e = register(n, 4);
  const div = register(n, 3);
  n.setDs(div, incIf(n, div, p.tick));
  const [r0, r1] = p.decay as [Sig, Sig];
  const fast = n.and(r1, r0);
  const med = n.and(r1, n.not(r0));
  const slow = n.and(n.not(r1), r0);
  const due = n.or(fast, n.or(n.and(med, div[0]!), n.and(slow, n.andAll(div))));
  const step = n.andAll([p.tick, due, n.not(isZero(n, e))]);
  n.setDs(e, muxWord(n, p.trig, p.vol, decIf(n, e, step)));
  n.region = prev;
  return e;
}

/** A phase accumulator of ACC_BITS bits advanced by `inc` each beat; reset to 0 when `reset`. */
function accumulator(n: Net, inc: Word, reset: Sig = 0): Word {
  const prev = n.region;
  n.region = "oscillator";
  const acc = register(n, ACC_BITS);
  const next = add(n, acc, resize(inc, ACC_BITS)).sum;
  n.setDs(acc, reset === 0 ? next : gate(n, next, n.not(reset)));
  n.region = prev;
  return acc;
}

/** Scale a 4-bit level by the envelope: (a * (e + 1)) >> 4 when e > 0, else 0. Full volume (15) keeps the level. */
export function scaleByEnvelope(n: Net, a: Word, e: Word): Word {
  const factor = incIf(n, resize(e, 5), n.not(isZero(n, e)));
  let acc: Word = resize([], 9);
  factor.forEach((bit, i) => {
    const row = resize([...Array(i).fill(0), ...a.map((x) => n.and(x, bit))], 9);
    acc = add(n, acc, row).sum;
  });
  return acc.slice(4, 8);
}

/** Folded triangle from the top five accumulator bits: 0..15..0. */
function triangle(n: Net, acc: Word): Word {
  const top = acc[ACC_BITS - 1]!;
  return acc.slice(ACC_BITS - 5, ACC_BITS - 1).map((x) => n.xor(x, top));
}

export interface Instrument {
  key: string;
  name: string;
  summary: string;
  tones: [string, string, string, string];
  build(): BuildResult;
}

/** Pulse wave with four duty cycles. */
function buildPulse(): BuildResult {
  const n = new Net();
  const p = voicePins(n);
  const acc = accumulator(n, p.inc);
  n.region = "waveform";
  const [a17, a16, a15] = [acc[17]!, acc[16]!, acc[15]!];
  const d50 = a17;
  const d25 = n.and(a17, a16);
  const d12 = n.and(d25, a15);
  const d75 = n.or(a17, a16);
  const [t0, t1] = p.tone as [Sig, Sig];
  const level = n.mux(t1, n.mux(t0, d75, d12), n.mux(t0, d25, d50));
  const env = envelope(n, p);
  n.region = "output";
  const amp = gate(n, env, n.and(level, p.gate));
  return n.build(amp);
}

/** Triangle (or sawtooth) scaled by the envelope. */
function buildTriangle(): BuildResult {
  const n = new Net();
  const p = voicePins(n);
  const acc = accumulator(n, p.inc);
  n.region = "waveform";
  const tri = triangle(n, acc);
  const saw = acc.slice(ACC_BITS - 4, ACC_BITS);
  const wave = muxWord(n, p.tone[0]!, saw, tri);
  const env = envelope(n, p);
  n.region = "output";
  const amp = gate(n, scaleByEnvelope(n, wave, env), p.gate);
  return n.build(amp);
}

/** Noise from a 15-bit LFSR clocked by the accumulator's carry; tone bit 0 selects the short, metallic sequence. */
function buildNoise(): BuildResult {
  const n = new Net();
  const p = voicePins(n);
  n.region = "oscillator";
  const acc = register(n, INC_BITS);
  const { sum, carry } = add(n, acc, p.inc);
  n.setDs(acc, sum);
  n.region = "lfsr";
  const lfsr = register(n, 15);
  const tap = n.mux(p.tone[0]!, lfsr[6]!, lfsr[1]!);
  const fb = n.xnor(lfsr[0]!, tap);
  const shifted = [...lfsr.slice(1), fb];
  n.setDs(lfsr, muxWord(n, carry, shifted, lfsr));
  const env = envelope(n, p);
  n.region = "output";
  const amp = gate(n, env, n.and(lfsr[0]!, p.gate));
  return n.build(amp);
}

/** Kick and toms: a triangle whose pitch falls by 1/8 (or 1/4, tone bit 0) of itself on every tick. */
function buildKick(): BuildResult {
  const n = new Net();
  const p = voicePins(n);
  n.region = "pitch";
  const q = register(n, INC_BITS);
  const drop = muxWord(n, p.tone[0]!, shr(q, 2), shr(q, 3));
  const fallen = sub(n, q, drop).diff;
  const held = muxWord(n, p.tick, fallen, q);
  n.setDs(q, muxWord(n, p.trig, p.inc, held));
  const acc = accumulator(n, q, p.trig);
  n.region = "waveform";
  const tri = triangle(n, acc);
  const env = envelope(n, p);
  n.region = "output";
  const amp = gate(n, scaleByEnvelope(n, tri, env), p.gate);
  return n.build(amp);
}

/** Arpeggio: cycles root, third and fifth every two ticks; tone bit 0 minor, tone bit 1 a 50 % pulse (else 25 %). */
function buildArp(): BuildResult {
  const n = new Net();
  const p = voicePins(n);
  n.region = "sequencer";
  const half = register(n, 1);
  n.setDs(half, [n.xor(half[0]!, p.tick)]);
  const adv = n.and(p.tick, half[0]!);
  const step = register(n, 2);
  const atTwo = n.and(step[1]!, n.not(step[0]!));
  const stepNext = muxWord(n, atTwo, [0, 0], incIf(n, step, 1));
  n.setDs(step, gate(n, muxWord(n, adv, stepNext, step), n.not(p.trig)));
  n.region = "intervals";
  const inc = resize(p.inc, INC_BITS + 1);
  const major = shr(inc, 2);
  const minor = add(n, shr(inc, 3), shr(inc, 4)).sum;
  const third = add(n, inc, muxWord(n, p.tone[0]!, minor, major)).sum;
  const fifth = add(n, inc, shr(inc, 1)).sum;
  const sel = muxWord(n, step[1]!, fifth, muxWord(n, step[0]!, third, inc));
  const acc = accumulator(n, sel);
  n.region = "waveform";
  const level = n.mux(p.tone[1]!, acc[17]!, n.and(acc[17]!, acc[16]!));
  const env = envelope(n, p);
  n.region = "output";
  const amp = gate(n, env, n.and(level, p.gate));
  return n.build(amp);
}

export const INSTRUMENTS: Record<string, Instrument> = {
  pulse: {
    key: "pulse",
    name: "Pulse",
    summary: "Square and pulse waves, the lead voice of 8-bit music",
    tones: ["50 % square", "25 % pulse", "12.5 % pulse", "75 % pulse"],
    build: buildPulse,
  },
  triangle: {
    key: "triangle",
    name: "Triangle",
    summary: "Soft 4-bit triangle for bass lines, or a sawtooth",
    tones: ["triangle", "sawtooth", "triangle", "sawtooth"],
    build: buildTriangle,
  },
  noise: {
    key: "noise",
    name: "Noise",
    summary: "15-bit LFSR noise for hats, snares and cymbals",
    tones: ["white noise", "metallic noise", "white noise", "metallic noise"],
    build: buildNoise,
  },
  kick: {
    key: "kick",
    name: "Kick",
    summary: "A falling triangle for kick drums and toms",
    tones: ["slow drop", "fast drop", "slow drop", "fast drop"],
    build: buildKick,
  },
  arp: {
    key: "arp",
    name: "Arpeggio",
    summary: "Major or minor chords played as a fast arpeggio, the chiptune chord",
    tones: ["major, thin", "minor, thin", "major, full", "minor, full"],
    build: buildArp,
  },
};

export const INSTRUMENT_KEYS = Object.keys(INSTRUMENTS);
