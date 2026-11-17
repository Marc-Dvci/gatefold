/**
 * The songs that ship with Gatefold, the instrument library, and compiled songs ready to play.
 */
import { type FlatProgram, flatten, simplify } from "../core/flat";
import { INSTRUMENTS } from "../core/instruments";
import { type CompiledSong, Library, type Song, compileSong, localLibrary } from "../core/song";
import { refKey } from "../core/tap02";
import { DEPLOYMENT } from "../deployments";
import theme from "../../songs/gatefold-theme.json";
import ode from "../../songs/ode-to-joy.json";
import king from "../../songs/mountain-king.json";

export interface CatalogSong {
  slug: string;
  /** The song's file in songs/, which is also its key in the deployment written by scripts/deploy.ts. */
  file: string;
  side: string;
  song: Song;
}

export const CATALOG: CatalogSong[] = [
  { slug: "gatefold", file: "gatefold-theme", side: "A1", song: theme as Song },
  { slug: "mountain-king", file: "mountain-king", side: "A2", song: king as Song },
  { slug: "ode-to-joy", file: "ode-to-joy", side: "B1", song: ode as Song },
];

let lib: Library | null = null;

/** The instrument library: the deployed circuits on X Layer when there are any, else the local preview. */
export function library(): Library {
  if (!lib) {
    lib = DEPLOYMENT
      ? new Library(DEPLOYMENT.processor, Object.fromEntries(Object.entries(DEPLOYMENT.instruments).map(([k, v]) => [k, BigInt(v)])))
      : localLibrary();
  }
  return lib;
}

export interface Prepared {
  key: string;
  cs: CompiledSong;
  program: FlatProgram;
  regionOf(instance: number, elem: number): string;
  label(instance: number): string;
}

const cache = new Map<string, Prepared>();

export function prepare(song: Song): Prepared {
  const key = JSON.stringify(song);
  const hit = cache.get(key);
  if (hit) return hit;
  const l = library();
  const cs = compileSong(song, l);
  const program = simplify(flatten(cs.circuit));
  const byRef = new Map<string, string[]>();
  for (const e of l.entries.values()) byRef.set(refKey(e.target.cpu, e.target.id), e.build.regions);
  const p: Prepared = {
    key,
    cs,
    program,
    regionOf(instance, elem) {
      const inst = program.instances[instance]!;
      if (instance === 0) return cs.regions[elem] ?? "logic";
      return byRef.get(refKey(inst.cpu!, inst.id!))?.[elem] ?? "logic";
    },
    label(instance) {
      if (instance === 0) return `${song.title}: sequencer, score, mixer`;
      const ch = song.channels[instance - 1];
      return ch ? `${ch.name} · ${INSTRUMENTS[ch.instrument]?.name ?? ch.instrument}` : `instance ${instance}`;
    },
  };
  cache.set(key, p);
  if (cache.size > 24) cache.delete(cache.keys().next().value!);
  return p;
}

/** Pins as the circuit reads them: intensity in pins 0-1, drive in pin 2. */
export function pinBits(intensity: number, drive: boolean): Uint8Array {
  return new Uint8Array([intensity & 1, (intensity >> 1) & 1, drive ? 1 : 0]);
}

export function songOnChain(slug: string, deployment = DEPLOYMENT): { processor: string; id: bigint } | null {
  const file = CATALOG.find((c) => c.slug === slug)?.file ?? slug;
  const id = deployment?.songs[file];
  return deployment && id ? { processor: deployment.processor, id: BigInt(id) } : null;
}
