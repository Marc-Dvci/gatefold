/**
 * Compile every song in songs/ and write what a judge can open without running anything:
 *
 *   examples/instruments/<key>.json   each instrument netlist, as a tape-out stores it
 *   examples/songs/<slug>.json        each song netlist with its stats, and its first samples
 *   examples/audio/<slug>.wav         the song rendered from its circuit (24 kHz mono, one pass)
 *
 * The first samples let scripts/crosscheck_reference.py replay each song with the official TAP-02 reference
 * implementation and compare, sample by sample.
 *
 *   npm run songs
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BEAT_RATE, INSTRUMENTS } from "../src/core/instruments";
import { FULL, cdWavBytes, renderBeats, toPcm16, wav } from "../src/core/render";
import { type Song, compileSong, localLibrary } from "../src/core/song";
import { OP_REF, bytesToHex } from "../src/core/tap02";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIRST = 24_000;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const lib = localLibrary();
for (const d of ["examples/instruments", "examples/songs", "examples/audio"]) mkdirSync(join(ROOT, d), { recursive: true });

for (const [key, inst] of Object.entries(INSTRUMENTS)) {
  const e = lib.get(key);
  writeFileSync(
    join(ROOT, `examples/instruments/${key}.json`),
    JSON.stringify(
      {
        instrument: inst.name,
        summary: inst.summary,
        previewCircuit: { cpu: e.target.cpu, id: e.target.id.toString() },
        nIn: e.build.nIn,
        nOut: e.build.nOut,
        nand: e.build.nand,
        latch: e.build.latch,
        bytes: e.build.bytes.length,
        sha256: sha(e.build.bytes),
        netlist: bytesToHex(e.build.bytes),
      },
      null,
      2,
    ) + "\n",
  );
}

const summary: Array<Record<string, unknown>> = [];
for (const f of readdirSync(join(ROOT, "songs")).filter((x) => x.endsWith(".json")).sort()) {
  const slug = f.replace(/\.json$/, "");
  const song = JSON.parse(readFileSync(join(ROOT, "songs", f), "utf8")) as Song;
  const cs = compileSong(song, lib);
  const raw = renderBeats(cs, cs.beats, FULL);
  const seconds = cs.beats / BEAT_RATE;
  const refs = cs.build.elements.filter((e) => e.op === OP_REF).map((e, i) => ({ channel: song.channels[i]!.name, instrument: song.channels[i]!.instrument, cpu: e.op === OP_REF ? e.cpu : "", id: e.op === OP_REF ? e.id.toString() : "" }));
  const stats = {
    seconds: Math.round(seconds * 10) / 10,
    rows: cs.rows,
    nand: cs.build.nand,
    latch: cs.build.latch,
    refs: cs.build.refs,
    bytes: cs.build.bytes.length,
    gatesWithInstruments: cs.circuit.nGates,
    stateBits: cs.circuit.nState,
    cdWavBytes: cdWavBytes(seconds),
    smallerBy: Math.round(cdWavBytes(seconds) / cs.build.bytes.length),
  };
  writeFileSync(
    join(ROOT, `examples/songs/${slug}.json`),
    JSON.stringify(
      {
        title: song.title,
        artist: song.artist,
        credit: song.credit,
        pins: { intensity: 3, drive: false },
        stats,
        nIn: cs.build.nIn,
        nOut: cs.build.nOut,
        sha256: sha(cs.build.bytes),
        refs,
        netlist: cs.netlistHex,
        firstSamples: Array.from(raw.slice(0, FIRST)),
      },
      null,
      1,
    ) + "\n",
  );
  writeFileSync(join(ROOT, `examples/audio/${slug}.wav`), wav(toPcm16(raw, song.channels.length)));
  summary.push({ slug, title: song.title, ...stats });
  console.log(`${slug}: ${stats.bytes} bytes, ${stats.nand} NAND + ${stats.latch} LATCH + ${stats.refs} REF, ${stats.seconds} s, ${stats.smallerBy}x smaller than a CD-quality WAV`);
}
writeFileSync(join(ROOT, "examples/songs/summary.json"), JSON.stringify(summary, null, 2) + "\n");
