/**
 * The song compiler: a score in, a TapeOut circuit out.
 *
 * A song circuit holds a sequencer (an envelope prescaler, a tick counter and a row counter), one ROM per channel
 * with that channel's notes, a note table per channel, a TAP-02 REF to an instrument circuit per channel, and a mixer.
 * Its outputs are an unsigned PCM sample, one per beat. Its three input pins let a game steer it while it plays:
 * pins 0-1 are the intensity (a channel plays when the intensity reaches its layer) and pin 2 is the drive (the faster
 * tempo).
 */
import { eqConst, gate, geConst, incIf, isZero, muxWord, register, rom, sumWords, konst, type Word } from "./arith";
import { ACC_BITS, BEAT_RATE, INC_BITS, INSTRUMENTS, PRESCALE, VOICE_IN, VOICE_OUT } from "./instruments";
import { MmlError, parseMml } from "./mml";
import { type BuildResult, Net, type RefTarget, type Sig } from "./net";
import { type Circuit, type Resolver, bytesToHex, load, refKey } from "./tap02";

export interface ChannelSpec {
  name: string;
  /** A key of INSTRUMENTS. */
  instrument: string;
  /** Instrument-specific tone, 0-3 (pulse duty, triangle or saw, noise colour, kick drop, arp chord). */
  tone?: number;
  /** 0 none, 1 slow, 2 medium, 3 fast. */
  decay?: number;
  /** Lowest intensity at which this channel plays, 0-3. */
  layer?: number;
  /** Fraction of a note's last row that sounds before release, 0.05-1 (1 is legato). */
  release?: number;
  mml: string;
}

export interface Song {
  title: string;
  artist: string;
  /** Who wrote the music and its status, shown on the release page. */
  credit?: string;
  bpm: number;
  /** Tempo while the drive pin is on. Defaults to bpm. */
  driveBpm?: number;
  /** Rows per quarter note: 4 (sixteenths) or 6 (also eighth-note triplets), etc. */
  rowsPerBeat: number;
  /** Row the song loops back to after its last row. */
  loopRow?: number;
  channels: ChannelSpec[];
}

export const SONG_PINS = 3;
export const PIN_NAMES = ["intensity 0", "intensity 1", "drive"];

/** The Gatefold instrument circuits and where they live (a processor contract and circuit ids). */
export interface LibraryEntry {
  key: string;
  target: RefTarget;
  build: BuildResult;
  circuit: Circuit;
}

export class Library {
  readonly entries = new Map<string, LibraryEntry>();
  private readonly byRef = new Map<string, Circuit>();

  /** Build every instrument, placed at `ids[key]` on processor `cpu`. */
  constructor(
    readonly cpu: string,
    ids: Record<string, bigint>,
  ) {
    for (const [key, inst] of Object.entries(INSTRUMENTS)) {
      const id = ids[key];
      if (id === undefined) continue;
      const build = inst.build();
      const circuit = load(build.bytes, build.nIn, build.nOut);
      const target: RefTarget = { cpu: cpu.toLowerCase(), id, nIn: build.nIn, nOut: build.nOut, name: inst.name };
      this.entries.set(key, { key, target, build, circuit });
      this.byRef.set(refKey(cpu, id), circuit);
    }
  }

  get(key: string): LibraryEntry {
    const e = this.entries.get(key);
    if (!e) throw new Error(`unknown instrument "${key}"`);
    return e;
  }

  /** Resolve REF targets to the library's circuits; anything else goes to `fallback` (for example the chain). */
  resolver(fallback?: Resolver): Resolver {
    return (cpu, id) => this.byRef.get(refKey(cpu, id)) ?? fallback?.(cpu, id);
  }

  /** Add a circuit (for example a song referenced by a remix) so the resolver can find it. */
  add(cpu: string, id: bigint, c: Circuit): void {
    this.byRef.set(refKey(cpu, id), c);
  }
}

/** The processor address Gatefold uses for circuits that are not taped out yet (local preview). */
export const LOCAL_CPU = "0x00000000000000000000000000000000ca55e77e";

/** Instruments at ids 1-5 of the local preview processor. */
export function localLibrary(): Library {
  return new Library(
    LOCAL_CPU,
    Object.fromEntries(Object.keys(INSTRUMENTS).map((k, i) => [k, BigInt(i + 1)])),
  );
}

export interface ChannelInfo {
  name: string;
  instrument: string;
  layer: number;
  notes: number;
  distinctNotes: number;
}

export interface CompiledSong {
  song: Song;
  build: BuildResult;
  circuit: Circuit;
  /** Rows in one pass of the song. */
  rows: number;
  rowBeats: number;
  driveRowBeats: number;
  /** Beats in one pass at the normal tempo. */
  beats: number;
  /** Width of the PCM output. */
  outBits: number;
  channels: ChannelInfo[];
  /** Region label of every top-level record, for the die view. */
  regions: string[];
  netlistHex: string;
}

export class SongError extends Error {
  constructor(
    message: string,
    readonly channel?: number,
    readonly position?: number,
  ) {
    super(message);
    this.name = "SongError";
  }
}

/** Phase increment for a pitched instrument. */
export function noteInc(midi: number, beatRate = BEAT_RATE): number {
  const f = 440 * 2 ** ((midi - 69) / 12);
  return Math.round((f * 2 ** ACC_BITS) / beatRate);
}

/** Clock increment for the noise instrument: n96 (c7) is the brightest, each octave down halves the rate. */
export function noiseInc(midi: number): number {
  return Math.min(2 ** INC_BITS - 1, Math.round(2 ** INC_BITS * 2 ** ((midi - 96) / 12)));
}

const bitsFor = (n: number): number => Math.max(1, Math.ceil(Math.log2(n + 1)));

export function rowBeatsFor(bpm: number, rowsPerBeat: number, beatRate = BEAT_RATE): number {
  return Math.round((beatRate * 60) / (bpm * rowsPerBeat));
}

/** Compile a song against the instrument library. */
export function compileSong(song: Song, lib: Library): CompiledSong {
  if (!song.channels.length) throw new SongError("a song needs at least one channel");
  if (song.channels.length > 8) throw new SongError("a song has at most 8 channels");
  if (!(song.bpm >= 30 && song.bpm <= 300)) throw new SongError("tempo must be 30 to 300 BPM");
  const driveBpm = song.driveBpm ?? song.bpm;
  if (!(driveBpm >= 30 && driveBpm <= 300)) throw new SongError("drive tempo must be 30 to 300 BPM");
  if (![1, 2, 3, 4, 6, 8, 12].includes(song.rowsPerBeat)) throw new SongError("rows per beat must be 1, 2, 3, 4, 6, 8 or 12");

  const parts = song.channels.map((ch, c) => {
    if (!INSTRUMENTS[ch.instrument]) throw new SongError(`unknown instrument "${ch.instrument}"`, c);
    try {
      return parseMml(ch.mml, song.rowsPerBeat);
    } catch (e) {
      if (e instanceof MmlError) throw new SongError(`${ch.name}: ${e.message}`, c, e.position);
      throw e;
    }
  });
  const rows = Math.max(...parts.map((p) => p.rows));
  if (rows === 0) throw new SongError("the song has no rows");
  if (rows > 4096) throw new SongError("a song has at most 4096 rows");
  const loopRow = song.loopRow ?? 0;
  if (loopRow < 0 || loopRow >= rows) throw new SongError("loop row must be inside the song");

  const rowBeats = rowBeatsFor(song.bpm, song.rowsPerBeat);
  const driveRowBeats = rowBeatsFor(driveBpm, song.rowsPerBeat);
  const n = new Net();

  // Pins.
  n.region = "pins";
  const intensity = [n.input(), n.input()];
  const drive = n.input();

  // Envelope prescaler: one tick every 2^PRESCALE beats.
  n.region = "clock";
  const pre = register(n, PRESCALE);
  n.setDs(pre, incIf(n, pre, 1));
  const tick = n.andAll(pre);

  // Tick counter: beats within the row.
  n.region = "sequencer";
  const tbits = bitsFor(Math.max(rowBeats, driveRowBeats));
  const t = register(n, tbits);
  const wrap = n.mux(drive, geConst(n, t, driveRowBeats - 1), geConst(n, t, rowBeats - 1));
  n.setDs(t, gate(n, incIf(n, t, 1), n.not(wrap)));
  const first = isZero(n, t);

  // Row counter.
  const pbits = bitsFor(rows - 1);
  const pos = register(n, pbits);
  const atEnd = eqConst(n, pos, rows - 1);
  const advanced = muxWord(n, atEnd, konst(pbits, loopRow), incIf(n, pos, 1));
  n.setDs(pos, muxWord(n, wrap, advanced, pos));

  const amps: Word[] = [];
  const infos: ChannelInfo[] = [];
  song.channels.forEach((ch, c) => {
    const part = parts[c]!;
    const inst = lib.get(ch.instrument);
    const tone = ch.tone ?? 0;
    const decay = ch.decay ?? 0;
    const layer = ch.layer ?? 0;
    const release = ch.release ?? 1;
    if (![0, 1, 2, 3].includes(tone) || ![0, 1, 2, 3].includes(decay) || ![0, 1, 2, 3].includes(layer)) {
      throw new SongError(`${ch.name}: tone, decay and layer are 0 to 3`, c);
    }
    if (!(release > 0 && release <= 1)) throw new SongError(`${ch.name}: release must be above 0 and at most 1`, c);

    // Per-row fields: note index (0 = silence), attack, last row of a note, volume.
    const incOf = (m: number): number => (ch.instrument === "noise" ? noiseInc(m) : noteInc(m));
    const distinct = [...new Set(part.notes.map((x) => incOf(x.midi)))].sort((a, b) => a - b);
    for (const v of distinct) {
      if (v >= 2 ** INC_BITS) throw new SongError(`${ch.name}: a note is too high for the ${inst.target.name} (pitch ${v})`, c);
    }
    const idxBits = bitsFor(distinct.length);
    const noteIdx = new Array<number>(rows).fill(0);
    const trig = new Array<number>(rows).fill(0);
    const last = new Array<number>(rows).fill(0);
    const vols = new Array<number>(rows).fill(0);
    for (const ev of part.notes) {
      const k = distinct.indexOf(incOf(ev.midi)) + 1;
      for (let r = ev.row; r < ev.row + ev.rows && r < rows; r++) {
        noteIdx[r] = k;
        vols[r] = ev.vol;
      }
      trig[ev.row] = 1;
      last[ev.row + ev.rows - 1] = 1;
    }
    const usedVols = new Set(part.notes.map((x) => x.vol));
    const constVol = usedVols.size <= 1 ? (part.notes[0]?.vol ?? 0) : -1;
    const legato = release >= 1;
    const words = noteIdx.map(
      (k, r) =>
        k |
        (trig[r]! << idxBits) |
        ((legato ? 0 : last[r]!) << (idxBits + 1)) |
        ((constVol >= 0 ? 0 : vols[r]!) << (idxBits + 2)),
    );
    const width = idxBits + 2 + (constVol >= 0 ? 0 : 4);
    n.region = `${ch.name} score`;
    const fields = rom(n, pos, words, width);
    const idx = fields.slice(0, idxBits);
    const trigBit = fields[idxBits]!;
    const lastBit = fields[idxBits + 1]!;
    const vol = constVol >= 0 ? konst(4, constVol) : fields.slice(idxBits + 2, idxBits + 6);

    n.region = `${ch.name} pitch`;
    const inc = rom(n, idx, [0, ...distinct], INC_BITS);
    const sounding = n.not(isZero(n, idx));
    const relAt = (beats: number): number => Math.max(1, Math.round(beats * release));
    const releasing = legato
      ? 0
      : n.and(lastBit, n.mux(drive, geConst(n, t, relAt(driveRowBeats)), geConst(n, t, relAt(rowBeats))));
    const on = n.and(sounding, n.not(releasing));
    const layerOn = geConst(n, intensity, layer);
    n.region = `${ch.name} control`;
    const g = n.and(on, layerOn);
    const attack = n.and(trigBit, first);
    const mode = konst(4, tone | (decay << 2));
    const ins: Sig[] = [...inc, attack, g, tick, ...vol, ...mode];
    if (ins.length !== VOICE_IN) throw new Error("internal: voice interface width");
    const amp = n.ref(inst.target, ins, `${ch.name}`);
    if (amp.length !== VOICE_OUT) throw new Error("internal: voice output width");
    amps.push(amp);
    infos.push({ name: ch.name, instrument: ch.instrument, layer, notes: part.notes.length, distinctNotes: distinct.length });
  });

  n.region = "mixer";
  const outBits = bitsFor(15 * song.channels.length);
  const mix = sumWords(n, amps).slice(0, outBits);
  while (mix.length < outBits) mix.push(0);
  const build = n.build(mix);
  const circuit = load(build.bytes, build.nIn, build.nOut, lib.resolver());
  return {
    song,
    build,
    circuit,
    rows,
    rowBeats,
    driveRowBeats,
    beats: rows * rowBeats,
    outBits,
    channels: infos,
    regions: build.regions,
    netlistHex: bytesToHex(build.bytes),
  };
}
