import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JsEngine, flatten, simplify } from "../src/core/flat";
import { BEAT_RATE, INSTRUMENTS, INSTRUMENT_KEYS, VOICE_IN, VOICE_OUT } from "../src/core/instruments";
import { MmlError, parseMml } from "../src/core/mml";
import { FULL, cdWavBytes, renderBeats, toPcm16, wav } from "../src/core/render";
import { LOCAL_CPU, Library, type Song, SongError, compileSong, localLibrary, noiseInc, noteInc, rowBeatsFor } from "../src/core/song";
import { OP_REF, beat, bitsToInt, intToBits } from "../src/core/tap02";

const lib = localLibrary();

describe("MML", () => {
  it.each([
    ["c d e", 4, [[0, 4, 60], [4, 4, 62], [8, 4, 64]]],
    ["o5 l8 a", 4, [[0, 2, 81]]],
    ["c+4 d-4 e#4", 4, [[0, 4, 61], [4, 4, 61], [8, 4, 65]]],
    ["c4. d8", 4, [[0, 6, 60], [6, 2, 62]]],
    ["c4&c4 c4", 4, [[0, 8, 60], [8, 4, 60]]],
    ["r4 c", 4, [[4, 4, 60]]],
    ["o4 b > c < b", 4, [[0, 4, 71], [4, 4, 72], [8, 4, 71]]],
    ["[c d]3", 4, [[0, 4, 60], [4, 4, 62], [8, 4, 60], [12, 4, 62], [16, 4, 60], [20, 4, 62]]],
    ["[[c]2 d]2", 4, [[0, 4, 60], [4, 4, 60], [8, 4, 62], [12, 4, 60], [16, 4, 60], [20, 4, 62]]],
    ["n36,8 n60", 4, [[0, 2, 36], [2, 4, 60]]],
    ["c12 c12 c12", 6, [[0, 2, 60], [2, 2, 60], [4, 2, 60]]],
    ["c | d ; a comment c d e\n e", 4, [[0, 4, 60], [4, 4, 62], [8, 4, 64]]],
  ] as const)("%s", (src, rpq, expected) => {
    const part = parseMml(src, rpq);
    expect(part.notes.map((n) => [n.row, n.rows, n.midi])).toEqual(expected);
  });

  it("carries volume, tone and decay on each note", () => {
    const p = parseMml("v9 @2 @d3 c v15 @1 d", 4);
    expect(p.notes.map((n) => [n.vol, n.tone, n.decay])).toEqual([[9, 2, 3], [15, 1, 3]]);
    expect(parseMml("c", 4).notes[0]).toMatchObject({ vol: 12, tone: -1, decay: -1 });
  });

  it("counts rests in the part's length", () => {
    expect(parseMml("c4 r2", 4).rows).toBe(12);
  });

  it.each([
    ["q", "unknown command"],
    ["c3", "does not fit a grid of 4 rows per beat"],
    ["c8..", "does not fit the row grid"],
    ["o9", "octave must be 0 to 8"],
    ["v16", "volume must be 0 to 15"],
    ["@4", "tone must be 0 to 3"],
    ["@d9", "decay must be 0 to 3"],
    ["[c", "unclosed ["],
    ["c]", "] without ["],
    ["[c]99", "repeat count"],
    ["n", "n needs a MIDI note number"],
    ["n130", "note out of range"],
    ["l", "l needs a length"],
    ["c99", "note length must be 1 to 64"],
  ])("refuses %s with a message that says where", (src, msg) => {
    expect(() => parseMml(src, 4)).toThrow(MmlError);
    expect(() => parseMml(src, 4)).toThrow(msg);
    expect(() => parseMml(src, 4)).toThrow("at character");
  });

  it("refuses repeats nested too deep", () => {
    expect(() => parseMml("[".repeat(12) + "c" + "]".repeat(12), 4)).toThrow("nested too deep");
  });
});

/** Run an instrument circuit directly with a held note; return its amplitude per beat. */
function playInstrument(key: string, inc: number, mode: number, beats: number, vol = 15): number[] {
  const c = lib.get(key).circuit;
  const e = new JsEngine(simplify(flatten(c)));
  const pins = (trig: number, tick: number) => {
    const p = new Uint8Array(VOICE_IN);
    p.set(intToBits(inc, 14), 0);
    p[14] = trig;
    p[15] = 1;
    p[16] = tick;
    p.set(intToBits(vol, 4), 17);
    p.set(intToBits(mode, 4), 21);
    return p;
  };
  const out: number[] = [];
  const w = new Int32Array(1);
  for (let t = 0; t < beats; t++) {
    e.run(1, pins(t === 0 ? 1 : 0, t % 256 === 0 ? 1 : 0), w);
    out.push(w[0]!);
  }
  return out;
}

/** Fundamental frequency from the rising crossings of the mean. */
function frequency(samples: number[]): number {
  const m = samples.reduce((a, b) => a + b, 0) / samples.length;
  const ups: number[] = [];
  for (let i = 1; i < samples.length; i++) if (samples[i - 1]! <= m && samples[i]! > m) ups.push(i);
  return ((ups.length - 1) * BEAT_RATE) / (ups[ups.length - 1]! - ups[0]!);
}

describe("instruments", () => {
  it.each(INSTRUMENT_KEYS)("%s has the Gatefold voice interface: 25 inputs, 4 outputs, no REF", (k) => {
    const e = lib.get(k);
    expect(e.build.nIn).toBe(VOICE_IN);
    expect(e.build.nOut).toBe(VOICE_OUT);
    expect(e.build.elements.some((x) => x.op === OP_REF)).toBe(false);
  });

  it.each([
    ["pulse", 0, 69],
    ["pulse", 1, 76],
    ["triangle", 0, 45],
    ["triangle", 1, 57],
  ] as const)("%s (tone %i) plays MIDI note %i within 0.3 %%", (key, tone, midi) => {
    const f = frequency(playInstrument(key, noteInc(midi), tone, 24_000));
    const want = 440 * 2 ** ((midi - 69) / 12);
    expect(Math.abs(f - want) / want).toBeLessThan(0.003);
  });

  it("the pulse duty cycle follows the tone pins", () => {
    const duty = (tone: number) => {
      const s = playInstrument("pulse", noteInc(57), tone, 24_000);
      return s.filter((x) => x > 0).length / s.length;
    };
    expect(duty(0)).toBeCloseTo(0.5, 2);
    expect(duty(1)).toBeCloseTo(0.25, 2);
    expect(duty(2)).toBeCloseTo(0.125, 2);
    expect(duty(3)).toBeCloseTo(0.75, 2);
  });

  it("the envelope holds with decay none and falls to silence with decay fast", () => {
    const hold = playInstrument("pulse", noteInc(60), 0, 12_000);
    expect(Math.max(...hold.slice(10_000))).toBe(15);
    const fast = playInstrument("pulse", noteInc(60), 3 << 2, 12_000);
    // 15 steps, one per tick of 256 beats: silent after 15 x 256 beats.
    expect(Math.max(...fast.slice(15 * 256 + 256))).toBe(0);
    expect(Math.max(...fast.slice(0, 256))).toBe(15);
  });

  it("decay slow lasts eight times longer than decay fast", () => {
    const lastSound = (mode: number) => {
      const s = playInstrument("pulse", noteInc(60), mode, 40_000);
      let last = 0;
      s.forEach((x, i) => (x > 0 ? (last = i) : 0));
      return last;
    };
    const fast = lastSound(3 << 2);
    const slow = lastSound(1 << 2);
    expect(slow / fast).toBeGreaterThan(7);
    expect(slow / fast).toBeLessThan(9);
  });

  it("noise is noise: both levels, no short period, and the two tones differ", () => {
    const white = playInstrument("noise", noiseInc(96), 0, 8_000);
    const metal = playInstrument("noise", noiseInc(96), 1, 8_000);
    expect(new Set(white)).toEqual(new Set([0, 15]));
    expect(white).not.toEqual(metal);
    const ones = white.filter((x) => x > 0).length / white.length;
    expect(ones).toBeGreaterThan(0.4);
    expect(ones).toBeLessThan(0.6);
  });

  it("the kick's pitch falls after the attack", () => {
    const s = playInstrument("kick", noteInc(55), 0, 6_000);
    expect(frequency(s.slice(0, 1_500))).toBeGreaterThan(frequency(s.slice(3_000, 6_000)) * 1.5);
  });

  it("the arpeggio cycles root, major third and fifth", () => {
    const s = playInstrument("arp", noteInc(69), 2, 24_000);
    // The first step lasts one tick (256 beats); after it, each step lasts two ticks (512 beats).
    const third = frequency(s.slice(256 + 20, 768 - 20));
    const fifth = frequency(s.slice(768 + 20, 1280 - 20));
    const root = frequency(s.slice(1280 + 20, 1792 - 20));
    expect(root / 440).toBeCloseTo(1, 1);
    expect(third / 440).toBeCloseTo(1.25, 1);
    expect(fifth / 440).toBeCloseTo(1.5, 1);
  });

  it("instrument netlists are deterministic: these are the bytes a tape-out stores", () => {
    const hashes = Object.fromEntries(INSTRUMENT_KEYS.map((k) => [k, createHash("sha256").update(lib.get(k).build.bytes).digest("hex").slice(0, 16)]));
    const again = localLibrary();
    for (const k of INSTRUMENT_KEYS) expect(createHash("sha256").update(again.get(k).build.bytes).digest("hex").slice(0, 16)).toBe(hashes[k]);
    expect(Object.keys(INSTRUMENTS)).toEqual(["pulse", "triangle", "noise", "kick", "arp"]);
  });
});

const demo = readdirSync(new URL("../songs/", import.meta.url))
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(new URL(`../songs/${f}`, import.meta.url), "utf8")) as Song] as const);

describe("songs", () => {
  it.each(demo)("%s compiles to a well-formed circuit with one REF per channel and PCM outputs last", (_f, song) => {
    const cs = compileSong(song, lib);
    expect(cs.build.refs).toBe(song.channels.length);
    expect(cs.circuit.nIn).toBe(3);
    expect(cs.build.elements.at(-1)!.out).toBe(cs.circuit.nSignals - 1);
    expect(cs.circuit.nGates).toBe(cs.build.nand + cs.build.latch + song.channels.reduce((a, c) => a + lib.get(c.instrument).circuit.nGates, 0));
  });

  it.each(demo)("%s: the netlist is at least 300 times smaller than the same audio as a CD-quality WAV", (_f, song) => {
    const cs = compileSong(song, lib);
    expect(cdWavBytes(cs.beats / BEAT_RATE) / cs.build.bytes.length).toBeGreaterThan(300);
  });

  it.each(demo)("%s: every compiled engine plays the same samples as the TAP-02 reference evaluator", (_f, song) => {
    const cs = compileSong(song, lib);
    const fast = renderBeats(cs, 4_000);
    let state: Uint8Array = new Uint8Array(cs.circuit.nState);
    for (let t = 0; t < 4_000; t++) {
      const r = beat(cs.circuit, state, FULL);
      state = r.newState;
      expect(bitsToInt(r.outputs)).toBe(fast[t]);
    }
  });

  const tiny = (over: Partial<Song> = {}, mml = "c d e f"): Song => ({
    title: "t",
    artist: "a",
    bpm: 120,
    rowsPerBeat: 4,
    channels: [{ name: "x", instrument: "pulse", mml }],
    ...over,
  });

  it("a channel above the intensity is silent, and plays once the intensity reaches its layer", () => {
    const song = tiny({ channels: [{ name: "x", instrument: "pulse", layer: 2, mml: "v15 c1" }] });
    const cs = compileSong(song, lib);
    const quiet = renderBeats(cs, 6_000, new Uint8Array([1, 0, 0]));
    const loud = renderBeats(cs, 6_000, new Uint8Array([0, 1, 0]));
    expect(Math.max(...quiet)).toBe(0);
    expect(Math.max(...loud)).toBe(15);
  });

  it("the drive pin switches to the faster tempo", () => {
    const song = tiny({ bpm: 100, driveBpm: 200, channels: [{ name: "x", instrument: "pulse", mml: "v15 l16 [c r]16" }] });
    const cs = compileSong(song, lib);
    expect(cs.driveRowBeats).toBe(rowBeatsFor(200, 4));
    const onsets = (pins: Uint8Array) => {
      const s = renderBeats(cs, 24_000, pins);
      let n = 0;
      // A note onset: sound after at least 400 beats of silence (a rest row is thousands of beats).
      for (let i = 400; i < s.length; i++) if (s[i]! > 0 && s.slice(i - 400, i).every((x) => x === 0)) n++;
      return n;
    };
    expect(onsets(new Uint8Array([1, 1, 1]))).toBeGreaterThan(onsets(new Uint8Array([1, 1, 0])) * 1.6);
  });

  it("the song loops back to its loop row after its last row", () => {
    const song = tiny({ loopRow: 4, channels: [{ name: "x", instrument: "pulse", mml: "v15 c r c c" }] });
    const cs = compileSong(song, lib);
    // Rows: c (0-3) r (4-7) c (8-11) c (12-15); after row 15 the song returns to row 4, a rest.
    const s = renderBeats(cs, cs.beats + 4 * cs.rowBeats);
    expect(Math.max(...s.slice(cs.beats + 50, cs.beats + 4 * cs.rowBeats - 50))).toBe(0);
    expect(Math.max(...s.slice(4 * cs.rowBeats + 50, 8 * cs.rowBeats - 50))).toBe(0);
  });

  it("a release shorter than the row cuts the end of each note", () => {
    const legato = compileSong(tiny({ channels: [{ name: "x", instrument: "pulse", release: 1, mml: "v15 c c" }] }), lib);
    const short = compileSong(tiny({ channels: [{ name: "x", instrument: "pulse", release: 0.3, mml: "v15 c c" }] }), lib);
    const sounding = (cs: typeof legato) => renderBeats(cs, cs.beats).filter((x) => x > 0).length;
    // Quarter notes are 4 rows: the release keeps 3 rows and 30 % of the last one, 82.5 % of the legato length.
    const ratio = sounding(short) / sounding(legato);
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(0.85);
  });

  it("a passage that repeats on an aligned block adds almost no gates", () => {
    const once = compileSong(tiny({}, "l16 v15 c d e f g a b > c < b a g f e d c d"), lib);
    const twice = compileSong(tiny({}, "l16 v15 [c d e f g a b > c < b a g f e d c d]2"), lib);
    expect(twice.build.nand).toBeLessThan(once.build.nand + 30);
  });

  it.each([
    [{ bpm: 10 }, "tempo must be 30 to 300"],
    [{ driveBpm: 400 }, "drive tempo"],
    [{ rowsPerBeat: 5 }, "rows per beat"],
    [{ channels: [] }, "at least one channel"],
    [{ channels: Array.from({ length: 9 }, () => ({ name: "x", instrument: "pulse", mml: "c" })) }, "at most 8 channels"],
    [{ channels: [{ name: "x", instrument: "kazoo", mml: "c" }] }, "unknown instrument"],
    [{ channels: [{ name: "x", instrument: "pulse", mml: "o8 c" }] }, "too high"],
    [{ channels: [{ name: "x", instrument: "pulse", tone: 7, mml: "c" }] }, "tone, decay and layer"],
    [{ channels: [{ name: "x", instrument: "pulse", release: 0, mml: "c" }] }, "release"],
    [{ channels: [{ name: "x", instrument: "pulse", mml: "r" }], loopRow: 9 }, "loop row"],
    [{ channels: [{ name: "x", instrument: "pulse", mml: "" }] }, "no rows"],
  ] as const)("refuses %j", (over, msg) => {
    expect(() => compileSong(tiny(over as Partial<Song>), lib)).toThrow(SongError);
    expect(() => compileSong(tiny(over as Partial<Song>), lib)).toThrow(msg);
  });

  it("names the channel of an MML error and where in it", () => {
    const err = (() => {
      try {
        compileSong(tiny({}, "c d q"), lib);
      } catch (e) {
        return e as SongError;
      }
    })()!;
    expect(err.channel).toBe(0);
    expect(err.position).toBe(4);
    expect(err.message).toContain("x: unknown command");
  });

  it("references the instruments wherever the library says they live", () => {
    const cpu = "0x" + "77".repeat(20);
    const placed = new Library(cpu, { pulse: 41n });
    const cs = compileSong(tiny(), placed);
    const ref = cs.build.elements.find((e) => e.op === OP_REF)!;
    expect(ref).toMatchObject({ cpu, id: 41n });
    expect(compileSong(tiny(), lib).build.elements.find((e) => e.op === OP_REF)).toMatchObject({ cpu: LOCAL_CPU, id: 1n });
    expect(() => placed.get("noise")).toThrow("unknown instrument");
  });
});

describe("rendering", () => {
  it("writes a valid mono 16-bit WAV", () => {
    const pcm = Int16Array.from([0, 1000, -1000, 32767]);
    const w = wav(pcm, 24_000);
    const v = new DataView(w.buffer);
    expect(new TextDecoder().decode(w.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(24_000);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(40, true)).toBe(8);
    expect(w.length).toBe(44 + 8);
  });

  it("maps silence to zero and stays inside 16 bits", () => {
    const silent = toPcm16(new Int32Array(2_000).fill(0), 5);
    expect(Math.max(...Array.from(silent, Math.abs))).toBe(0);
    const loud = toPcm16(Int32Array.from({ length: 2_000 }, (_, i) => (i % 2 ? 75 : 0)), 5);
    for (const x of loud) expect(Math.abs(x)).toBeLessThanOrEqual(32767);
  });

  it("sizes a CD-quality WAV as 44,100 two-byte samples a second plus its header", () => {
    expect(cdWavBytes(180)).toBe(44 + 180 * 44_100 * 2);
  });
});
