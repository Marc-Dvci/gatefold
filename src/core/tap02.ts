/**
 * TAP-02: the TapeOut netlist byte format and the semantics of one beat.
 *
 * This module implements the standard exactly as written in TAP-02 (Draft, 2026-10-04): the record encoding (§2),
 * well-formedness (§3), the state layout and one beat (§4) and LSB-first bit packing (§5). The test suite runs it
 * against the vectors published with the standard and against circuits read from X Layer.
 */

export const OP_NAND = 0x00;
export const OP_LATCH = 0x01;
export const OP_REF = 0x02;

export const MAX_SIGNALS = 1 << 24;
export const MAX_PINS = 1 << 16;
export const MAX_GATES = 2 ** 32 - 1;

/** A netlist that TAP-02 §3 rejects. The message follows the reference implementation's wording. */
export class IllFormed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllFormed";
  }
}

export interface NandElement {
  op: typeof OP_NAND;
  a: number;
  b: number;
  /** Index of the signal this element produces. */
  out: number;
}

export interface LatchElement {
  op: typeof OP_LATCH;
  d: number;
  out: number;
}

export interface RefElement {
  op: typeof OP_REF;
  /** Processor contract, lower-case 0x-prefixed hex, 20 bytes. */
  cpu: string;
  id: bigint;
  ins: number[];
  nOut: number;
  /** Index of the first signal this element produces. */
  out: number;
}

export type Element = NandElement | LatchElement | RefElement;

/** A circuit reference: the pair (processor contract, circuit id). */
export interface CircuitRef {
  cpu: string;
  id: bigint;
}

export function refKey(cpu: string, id: bigint): string {
  return `${cpu.toLowerCase()}:${id.toString()}`;
}

/** A decoded, well-formed circuit with its REF targets resolved (TAP-02 §3, §4). */
export interface Circuit {
  nIn: number;
  nOut: number;
  elements: Element[];
  nSignals: number;
  /** For each element, the first bit of its block in the state vector (meaningful for LATCH and REF). */
  stateBase: number[];
  nState: number;
  /** NAND + LATCH count including everything reached through REF, as circuitInfo reports it. */
  nGates: number;
  /** Top-level NAND + LATCH records only: what a tape-out burns in transistor tokens. */
  ownGates: number;
  subs: Map<string, Circuit>;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("invalid hex string");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "0x";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** Decode the records of a netlist (TAP-02 §2). Checks record lengths before reading (§7.2). */
export function decode(data: Uint8Array, nIn: number): Element[] {
  let p = 0;
  let next = 2 + nIn;
  const els: Element[] = [];
  const need = (k: number): void => {
    if (p + k > data.length) throw new IllFormed(`truncated record at byte ${p}`);
  };
  const u24 = (): number => {
    need(3);
    const v = (data[p]! << 16) | (data[p + 1]! << 8) | data[p + 2]!;
    p += 3;
    return v;
  };
  while (p < data.length) {
    const op = data[p]!;
    p += 1;
    if (op === OP_NAND) {
      const a = u24();
      const b = u24();
      els.push({ op: OP_NAND, a, b, out: next });
      next += 1;
    } else if (op === OP_LATCH) {
      els.push({ op: OP_LATCH, d: u24(), out: next });
      next += 1;
    } else if (op === OP_REF) {
      need(30);
      const cpu = bytesToHex(data.subarray(p, p + 20));
      p += 20;
      let id = 0n;
      for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(data[p + i]!);
      p += 8;
      const ni = data[p]!;
      const no = data[p + 1]!;
      p += 2;
      const ins: number[] = [];
      for (let i = 0; i < ni; i++) ins.push(u24());
      els.push({ op: OP_REF, cpu, id, ins, nOut: no, out: next });
      next += no;
    } else {
      throw new IllFormed(`unknown opcode 0x${op.toString(16).padStart(2, "0")} at byte ${p - 1}`);
    }
  }
  return els;
}

/** Encode records back to bytes (TAP-02 §2). `decode(encode(x))` returns x. */
export function encode(els: readonly Element[]): Uint8Array {
  let size = 0;
  for (const e of els) size += e.op === OP_NAND ? 7 : e.op === OP_LATCH ? 4 : 31 + 3 * e.ins.length;
  const out = new Uint8Array(size);
  let p = 0;
  const u24 = (v: number): void => {
    if (!Number.isInteger(v) || v < 0 || v >= MAX_SIGNALS) throw new IllFormed(`signal index ${v} out of range`);
    out[p] = (v >>> 16) & 0xff;
    out[p + 1] = (v >>> 8) & 0xff;
    out[p + 2] = v & 0xff;
    p += 3;
  };
  for (const e of els) {
    out[p++] = e.op;
    if (e.op === OP_NAND) {
      u24(e.a);
      u24(e.b);
    } else if (e.op === OP_LATCH) {
      u24(e.d);
    } else {
      const cpu = hexToBytes(e.cpu);
      if (cpu.length !== 20) throw new IllFormed("REF processor address must be 20 bytes");
      out.set(cpu, p);
      p += 20;
      let id = e.id;
      for (let i = 7; i >= 0; i--) {
        out[p + i] = Number(id & 0xffn);
        id >>= 8n;
      }
      p += 8;
      if (e.ins.length > 255 || e.nOut > 255) throw new IllFormed("REF pin count above 255");
      out[p++] = e.ins.length;
      out[p++] = e.nOut;
      for (const s of e.ins) u24(s);
    }
  }
  return out;
}

/** Resolves a REF target to a loaded circuit, or undefined when the target is not a circuit of a registered processor. */
export type Resolver = (cpu: string, id: bigint) => Circuit | undefined;

/** Decode and check well-formedness (TAP-02 §3), computing the state layout of §4. */
export function load(data: Uint8Array, nIn: number, nOut: number, resolve?: Resolver): Circuit {
  const elements = decode(data, nIn);
  let nSignals = 2 + nIn;
  for (const e of elements) nSignals += e.op === OP_REF ? e.nOut : 1;
  if (nSignals > MAX_SIGNALS) throw new IllFormed("more than 2^24 signals");
  if (!(nIn >= 0 && nIn <= MAX_PINS && nOut >= 1 && nOut <= MAX_PINS)) throw new IllFormed("nIn/nOut out of range");
  if (nSignals - 2 - nIn < nOut) throw new IllFormed("too few signals for outputs");
  const stateBase: number[] = [];
  const subs = new Map<string, Circuit>();
  let nState = 0;
  let nGates = 0;
  let ownGates = 0;
  for (const e of elements) {
    const ins = e.op === OP_NAND ? [e.a, e.b] : e.op === OP_LATCH ? [e.d] : e.ins;
    const limit = e.op === OP_LATCH ? nSignals : e.out;
    for (const s of ins) {
      if (s >= limit) throw new IllFormed(`signal ${s} referenced by element at ${e.out} is not available`);
    }
    stateBase.push(nState);
    if (e.op === OP_LATCH) {
      nState += 1;
      ownGates += 1;
    } else if (e.op === OP_NAND) {
      ownGates += 1;
    } else {
      if (!resolve) throw new IllFormed("REF without a resolver");
      const sub = resolve(e.cpu, e.id);
      if (!sub) throw new IllFormed("REF target is not a circuit of a registered processor");
      if (sub.nIn !== e.ins.length || sub.nOut !== e.nOut) {
        throw new IllFormed("REF arity does not match the target circuit");
      }
      if (sub.nState > MAX_SIGNALS) throw new IllFormed("REF size");
      subs.set(refKey(e.cpu, e.id), sub);
      nState += sub.nState;
      nGates += sub.nGates;
    }
  }
  nGates += ownGates;
  if (nState > MAX_SIGNALS || nGates > MAX_GATES) throw new IllFormed("size overflow");
  return { nIn, nOut, elements, nSignals, stateBase, nState, nGates, ownGates, subs };
}

export interface BeatResult {
  newState: Uint8Array;
  outputs: Uint8Array;
}

/**
 * One beat (TAP-02 §4). `state` and `inputs` hold one bit per entry (0 or 1).
 * This is the readable reference evaluator; the player uses the compiled form in `jit.ts`, which the tests hold to it.
 */
export function beat(c: Circuit, state: Uint8Array, inputs: Uint8Array): BeatResult {
  if (state.length !== c.nState || inputs.length !== c.nIn) throw new Error("state or input length mismatch");
  const s = new Uint8Array(c.nSignals);
  s[1] = 1;
  s.set(inputs, 2);
  const newState = state.slice();
  const els = c.elements;
  for (let i = 0; i < els.length; i++) {
    const e = els[i]!;
    if (e.op === OP_NAND) {
      s[e.out] = 1 ^ (s[e.a]! & s[e.b]!);
    } else if (e.op === OP_LATCH) {
      s[e.out] = state[c.stateBase[i]!]!;
    } else {
      const sub = c.subs.get(refKey(e.cpu, e.id))!;
      const base = c.stateBase[i]!;
      const subIn = new Uint8Array(e.ins.length);
      for (let k = 0; k < e.ins.length; k++) subIn[k] = s[e.ins[k]!]!;
      const r = beat(sub, state.subarray(base, base + sub.nState).slice(), subIn);
      newState.set(r.newState, base);
      s.set(r.outputs, e.out);
    }
  }
  for (let i = 0; i < els.length; i++) {
    const e = els[i]!;
    if (e.op === OP_LATCH) newState[c.stateBase[i]!] = s[e.d]!;
  }
  return { newState, outputs: s.slice(c.nSignals - c.nOut) };
}

/** Pack bits LSB first (TAP-02 §5): exactly ceil(n / 8) bytes, unused high bits zero. */
export function pack(bits: ArrayLike<number>): Uint8Array {
  const out = new Uint8Array((bits.length + 7) >> 3);
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3]! |= 1 << (i & 7);
  return out;
}

/** Unpack as the deployed evaluator reads inputs and state: missing bytes read as 0, extra bits ignored (§5). */
export function unpack(data: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i >> 3 < data.length ? (data[i >> 3]! >> (i & 7)) & 1 : 0;
  return out;
}

/** Bits (LSB first) to an unsigned integer. */
export function bitsToInt(bits: ArrayLike<number>): number {
  let v = 0;
  for (let i = bits.length - 1; i >= 0; i--) v = v * 2 + (bits[i] ? 1 : 0);
  return v;
}

/** Unsigned integer to `n` bits, LSB first. */
export function intToBits(v: number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(v / 2 ** i) % 2;
  return out;
}
