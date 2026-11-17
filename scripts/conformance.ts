/**
 * Conformance against X Layer: for every circuit in tests/fixtures/xlayer-sample.json (40 with state, 40 without,
 * across 48 processors), read the netlist and its REF closure from the chain, then compare beats from random states
 * and inputs: Gatefold's reference evaluator, its typed-array engine and its generated JavaScript, against the
 * processor's own step() or eval() through eth_call. Read-only.
 *
 *   npx tsx scripts/conformance.ts          writes docs/evidence/xlayer-conformance.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFromChain, Processor } from "../src/chain/processor";
import { JsonRpc } from "../src/chain/rpc";
import { FlatEngine, JsEngine, flatten, simplify } from "../src/core/flat";
import { beat, bitsToInt, bytesToHex } from "../src/core/tap02";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BEATS_PER_CIRCUIT = 4;

export interface ConformanceResult {
  block: string;
  circuits: number;
  stateful: number;
  processors: number;
  beats: number;
  referenceMatches: number;
  engineMatches: number;
  failures: Array<{ cpu: string; id: number; reason: string }>;
  ms: number;
}

/** A small deterministic generator, so a run can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

export async function runConformance(rpc = new JsonRpc(), log = (s: string) => console.log(s)): Promise<ConformanceResult> {
  const fixture = JSON.parse(readFileSync(join(ROOT, "tests/fixtures/xlayer-sample.json"), "utf8")) as {
    sample: Array<{ cpu: string; id: number; nState: number }>;
  };
  const block = "0x" + (await rpc.blockNumber()).toString(16);
  const rand = rng(196);
  const bits = (n: number): Uint8Array => Uint8Array.from({ length: n }, () => (rand() < 0.5 ? 1 : 0));
  const t0 = Date.now();
  const res: ConformanceResult = {
    block: BigInt(block).toString(),
    circuits: 0,
    stateful: 0,
    processors: 0,
    beats: 0,
    referenceMatches: 0,
    engineMatches: 0,
    failures: [],
    ms: 0,
  };
  const cpus = new Set<string>();
  for (const s of fixture.sample) {
    try {
      const c = await loadFromChain(rpc, s.cpu, BigInt(s.id), block);
      const p = new Processor(rpc, s.cpu, block);
      const flat = simplify(flatten(c.circuit));
      const narrow = c.circuit.nOut <= 31;
      const engines = narrow ? [new FlatEngine(flat), new JsEngine(flat)] : [];
      res.circuits++;
      if (c.circuit.nState > 0) res.stateful++;
      cpus.add(s.cpu);
      for (let k = 0; k < BEATS_PER_CIRCUIT; k++) {
        const state = bits(c.circuit.nState);
        const inputs = bits(c.circuit.nIn);
        const local = beat(c.circuit, state, inputs);
        let chainOut: Uint8Array;
        let chainState: Uint8Array | null = null;
        if (c.circuit.nState === 0) chainOut = await p.eval(c.id, c.circuit.nOut, inputs);
        else {
          const r = await p.step(c.id, c.circuit.nState, c.circuit.nOut, state, inputs);
          chainOut = r.outputs;
          chainState = r.newState;
        }
        res.beats++;
        const sameRef =
          bytesToHex(chainOut) === bytesToHex(local.outputs) && (!chainState || bytesToHex(chainState) === bytesToHex(local.newState));
        if (sameRef) res.referenceMatches++;
        else res.failures.push({ cpu: s.cpu, id: s.id, reason: "reference evaluator differs from the chain" });
        // The compiled engines, from the same state, must give the same word and the same next state.
        let sameEngines = true;
        for (const e of engines) {
          e.state = state.slice();
          const out = new Int32Array(1);
          e.run(1, inputs, out);
          if (out[0] !== bitsToInt(chainOut) || (chainState && bytesToHex(e.state) !== bytesToHex(chainState))) sameEngines = false;
        }
        if (sameEngines) res.engineMatches++;
        else res.failures.push({ cpu: s.cpu, id: s.id, reason: "compiled engine differs from the chain" });
      }
      log(`${s.cpu} #${s.id}: ${c.circuit.nGates} gates, ${c.circuit.nState} state bits, ${BEATS_PER_CIRCUIT} beats checked`);
    } catch (e) {
      res.failures.push({ cpu: s.cpu, id: s.id, reason: (e as Error).message });
    }
  }
  res.processors = cpus.size;
  res.ms = Date.now() - t0;
  return res;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await runConformance();
  writeFileSync(
    join(ROOT, "docs/evidence/xlayer-conformance.json"),
    JSON.stringify(
      {
        what: "Gatefold's evaluators against X Layer step()/eval(), read-only, at one pinned block",
        date: new Date().toISOString().slice(0, 10),
        ...r,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${r.circuits} circuits (${r.stateful} with state) on ${r.processors} processors at block ${r.block}: reference ${r.referenceMatches}/${r.beats}, compiled ${r.engineMatches}/${r.beats}; ${r.failures.length} failures`,
  );
  process.exitCode = r.failures.length ? 1 : 0;
}
