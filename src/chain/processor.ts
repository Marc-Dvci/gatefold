/**
 * Read TapeOut circuits from a processor contract (TAP-02 §6) and check a beat against the chain.
 */
import { type Circuit, IllFormed, OP_REF, bytesToHex, decode, load, pack, refKey, unpack } from "../core/tap02";
import { decodeResult, encodeCall } from "./abi";
import type { JsonRpc } from "./rpc";

export const SEL = {
  nextId: "0x61b8ce8c",
  circuitInfo: "0x084d60f1",
  netlist: "0x3fc4be56",
  eval: "0x934d06ea",
  step: "0xe8281a1a",
  tapeout: "0x7bd3ac1d",
  ownerOf: "0x6352211e",
  cpuCount: "0xa94da8a7",
  cpuAt: "0x4bc7cbbd",
} as const;

export interface CircuitInfo {
  nIn: number;
  nOut: number;
  nState: number;
  gateCount: number;
}

/** Bounds for evaluating netlists read from the chain (TAP-02 §7.1). */
export const LIMITS = { maxGates: 200_000, maxDepth: 16, maxCircuits: 64 };

export class Processor {
  constructor(
    readonly rpc: JsonRpc,
    readonly address: string,
    readonly block = "latest",
  ) {}

  async nextId(): Promise<bigint> {
    const [v] = decodeResult(await this.rpc.call(this.address, SEL.nextId, this.block), ["uint"]);
    return v as bigint;
  }

  async info(id: bigint): Promise<CircuitInfo> {
    const r = await this.rpc.call(this.address, encodeCall(SEL.circuitInfo, [{ type: "uint", value: id }]), this.block);
    const [nIn, nOut, nState, gateCount] = decodeResult(r, ["uint", "uint", "uint", "uint"]) as bigint[];
    return { nIn: Number(nIn), nOut: Number(nOut), nState: Number(nState), gateCount: Number(gateCount) };
  }

  async netlist(id: bigint): Promise<Uint8Array> {
    const r = await this.rpc.call(this.address, encodeCall(SEL.netlist, [{ type: "uint", value: id }]), this.block);
    return decodeResult(r, ["bytes"])[0] as Uint8Array;
  }

  async ownerOf(id: bigint): Promise<string> {
    const r = await this.rpc.call(this.address, encodeCall(SEL.ownerOf, [{ type: "uint", value: id }]), this.block);
    return decodeResult(r, ["address"])[0] as string;
  }

  /** One beat on the chain with caller-supplied state (TAP-02 §6 `step`). Bits in, bits out. */
  async step(
    id: bigint,
    nState: number,
    nOut: number,
    state: Uint8Array,
    inputs: Uint8Array,
  ): Promise<{ newState: Uint8Array; outputs: Uint8Array }> {
    const data = encodeCall(SEL.step, [
      { type: "uint", value: id },
      { type: "bytes", value: pack(state) },
      { type: "bytes", value: pack(inputs) },
    ]);
    const r = await this.rpc.call(this.address, data, this.block);
    const [ns, out] = decodeResult(r, ["bytes", "bytes"]) as [Uint8Array, Uint8Array];
    return { newState: unpack(ns, nState), outputs: unpack(out, nOut) };
  }

  /** Combinational evaluation on the chain (TAP-02 §6 `eval`). */
  async eval(id: bigint, nOut: number, inputs: Uint8Array): Promise<Uint8Array> {
    const data = encodeCall(SEL.eval, [
      { type: "uint", value: id },
      { type: "bytes", value: pack(inputs) },
    ]);
    const r = await this.rpc.call(this.address, data, this.block);
    return unpack(decodeResult(r, ["bytes"])[0] as Uint8Array, nOut);
  }
}

export interface ChainCircuit {
  cpu: string;
  id: bigint;
  info: CircuitInfo;
  bytes: Uint8Array;
  circuit: Circuit;
  /** Every circuit in the REF closure, keyed by refKey. */
  closure: Map<string, { bytes: Uint8Array; info: CircuitInfo }>;
}

/**
 * Read a circuit and everything it references, check it against TAP-02 §3 and its `circuitInfo`, and return it ready
 * to evaluate. Refuses closures beyond LIMITS before evaluating anything.
 */
export async function loadFromChain(
  rpc: JsonRpc,
  cpu: string,
  id: bigint,
  block = "latest",
  known?: (cpu: string, id: bigint) => Circuit | undefined,
): Promise<ChainCircuit> {
  const closure = new Map<string, { bytes: Uint8Array; info: CircuitInfo }>();
  const visit = async (c: string, i: bigint, depth: number): Promise<void> => {
    const key = refKey(c, i);
    if (closure.has(key) || known?.(c, i)) return;
    if (depth > LIMITS.maxDepth) throw new IllFormed(`REF nesting deeper than ${LIMITS.maxDepth}`);
    if (closure.size >= LIMITS.maxCircuits) throw new IllFormed(`more than ${LIMITS.maxCircuits} circuits in the REF closure`);
    const p = new Processor(rpc, c, block);
    const info = await p.info(i);
    if (info.gateCount > LIMITS.maxGates)
      throw new IllFormed(`circuit has ${info.gateCount} gates, above the ${LIMITS.maxGates} this player evaluates`);
    const bytes = await p.netlist(i);
    closure.set(key, { bytes, info });
    // Find REF targets by decoding without resolving.
    for (const e of decode(bytes, info.nIn)) if (e.op === OP_REF) await visit(e.cpu, e.id, depth + 1);
  };
  await visit(cpu, id, 0);
  const loaded = new Map<string, Circuit>();
  const resolve = (c: string, i: bigint): Circuit | undefined => {
    const key = refKey(c, i);
    const hit = loaded.get(key) ?? known?.(c, i);
    if (hit) return hit;
    const entry = closure.get(key);
    if (!entry) return undefined;
    const circ = load(entry.bytes, entry.info.nIn, entry.info.nOut, resolve);
    loaded.set(key, circ);
    return circ;
  };
  const top = closure.get(refKey(cpu, id));
  const circuit = top ? resolve(cpu, id)! : known!(cpu, id)!;
  for (const [key, entry] of closure) {
    const c = loaded.get(key)!;
    if (c.nState !== entry.info.nState || c.nGates !== entry.info.gateCount) {
      throw new IllFormed(
        `circuit ${key} decodes to ${c.nState} state bits and ${c.nGates} gates, but the chain reports ${entry.info.nState} and ${entry.info.gateCount}`,
      );
    }
  }
  return {
    cpu: cpu.toLowerCase(),
    id,
    info: top?.info ?? { nIn: circuit.nIn, nOut: circuit.nOut, nState: circuit.nState, gateCount: circuit.nGates },
    bytes: top?.bytes ?? new Uint8Array(),
    circuit,
    closure,
  };
}

export { bytesToHex };
