/**
 * A gate-level circuit builder that emits TAP-02 netlists.
 *
 * Every gate is a NAND. The builder folds constants, removes double inversions and shares identical gates
 * (structural hashing), so a circuit is never larger than the logic it needs. A ROM built from multiplexers on top of
 * it becomes a reduced decision diagram: two aligned blocks of a song that hold the same notes become the same gates.
 * `build` drops logic that reaches no output, places the outputs as the last signals (TAP-02 §2) and encodes the bytes.
 */
import { type CircuitRef, type Element, OP_LATCH, OP_NAND, OP_REF, encode } from "./tap02";

/** A signal of the circuit under construction. 0 and 1 are the constants. */
export type Sig = number;

const KIND_CONST = 0;
const KIND_INPUT = 1;
const KIND_NAND = 2;
const KIND_LATCH = 3;
const KIND_REFOUT = 4;

/** A REF target with its pin counts, so the builder can check arity before the chain does. */
export interface RefTarget extends CircuitRef {
  nIn: number;
  nOut: number;
  /** A readable name for the die view and the stats. */
  name?: string;
}

interface RefCall {
  target: RefTarget;
  ins: Sig[];
  outs: Sig[];
  /** A label for this instance, e.g. "ch1 lead". */
  label: string;
}

export interface BuildResult {
  bytes: Uint8Array;
  elements: Element[];
  nIn: number;
  nOut: number;
  nand: number;
  latch: number;
  refs: number;
  /** For each REF element in record order, its label. */
  refLabels: string[];
  /** Region of each emitted NAND/LATCH element (the `region` active when it was created). */
  regions: string[];
}

export class Net {
  private kind: number[] = [KIND_CONST, KIND_CONST];
  private a: number[] = [0, 0];
  private b: number[] = [0, 0];
  private regionOf: string[] = ["", ""];
  private notOf = new Map<Sig, Sig>(); // x -> NOT x
  private isNot = new Map<Sig, Sig>(); // NOT x -> x
  private table = new Map<string, Sig>();
  private inputs: Sig[] = [];
  private refCalls: RefCall[] = [];
  private latchD = new Map<Sig, Sig>();
  /** Label attached to the gates created from now on (die view regions). */
  region = "logic";

  readonly ZERO: Sig = 0;
  readonly ONE: Sig = 1;

  private node(k: number, x: number, y: number): Sig {
    this.kind.push(k);
    this.a.push(x);
    this.b.push(y);
    this.regionOf.push(this.region);
    return this.kind.length - 1;
  }

  /** Declare the next input pin. Pins are numbered in declaration order. */
  input(): Sig {
    const s = this.node(KIND_INPUT, this.inputs.length, 0);
    this.inputs.push(s);
    return s;
  }

  inputs_(n: number): Sig[] {
    return Array.from({ length: n }, () => this.input());
  }

  get nIn(): number {
    return this.inputs.length;
  }

  nand(x: Sig, y: Sig): Sig {
    if (x > y) [x, y] = [y, x];
    if (x === 0) return 1;
    if (x === 1) return y === 1 ? 0 : this.not(y);
    if (x === y) return this.not(x);
    if (this.notOf.get(x) === y) return 1;
    const key = `${x},${y}`;
    const hit = this.table.get(key);
    if (hit !== undefined) return hit;
    const s = this.node(KIND_NAND, x, y);
    this.table.set(key, s);
    return s;
  }

  not(x: Sig): Sig {
    if (x === 0) return 1;
    if (x === 1) return 0;
    const back = this.isNot.get(x);
    if (back !== undefined) return back;
    const hit = this.notOf.get(x);
    if (hit !== undefined) return hit;
    const s = this.node(KIND_NAND, x, x);
    this.notOf.set(x, s);
    this.isNot.set(s, x);
    return s;
  }

  and(x: Sig, y: Sig): Sig {
    return this.not(this.nand(x, y));
  }

  or(x: Sig, y: Sig): Sig {
    return this.nand(this.not(x), this.not(y));
  }

  nor(x: Sig, y: Sig): Sig {
    return this.not(this.or(x, y));
  }

  xor(x: Sig, y: Sig): Sig {
    if (x === 0) return y;
    if (y === 0) return x;
    if (x === 1) return this.not(y);
    if (y === 1) return this.not(x);
    if (x === y) return 0;
    const t = this.nand(x, y);
    return this.nand(this.nand(x, t), this.nand(y, t));
  }

  xnor(x: Sig, y: Sig): Sig {
    return this.not(this.xor(x, y));
  }

  /** s ? x1 : x0 */
  mux(s: Sig, x1: Sig, x0: Sig): Sig {
    if (x1 === x0) return x1;
    if (s === 1) return x1;
    if (s === 0) return x0;
    if (x1 === 1 && x0 === 0) return s;
    if (x1 === 0 && x0 === 1) return this.not(s);
    if (x0 === 0) return this.and(s, x1);
    if (x1 === 0) return this.and(this.not(s), x0);
    if (x1 === 1) return this.or(s, x0);
    if (x0 === 1) return this.or(this.not(s), x1);
    return this.nand(this.nand(s, x1), this.nand(this.not(s), x0));
  }

  andAll(xs: Sig[]): Sig {
    if (xs.length === 0) return 1;
    let layer = xs.slice();
    while (layer.length > 1) {
      const next: Sig[] = [];
      for (let i = 0; i < layer.length; i += 2) next.push(i + 1 < layer.length ? this.and(layer[i]!, layer[i + 1]!) : layer[i]!);
      layer = next;
    }
    return layer[0]!;
  }

  orAll(xs: Sig[]): Sig {
    return this.not(this.andAll(xs.map((x) => this.not(x))));
  }

  /** A LATCH (one-beat delay). Its input is set later with `setD`, which allows feedback (TAP-02 §3.5). */
  latch(): Sig {
    return this.node(KIND_LATCH, -1, 0);
  }

  latches(n: number): Sig[] {
    return Array.from({ length: n }, () => this.latch());
  }

  setD(l: Sig, d: Sig): void {
    if (this.kind[l] !== KIND_LATCH) throw new Error("setD on a signal that is not a LATCH");
    if (this.latchD.has(l)) throw new Error("LATCH input already set");
    this.latchD.set(l, d);
  }

  setDs(ls: Sig[], ds: Sig[]): void {
    if (ls.length !== ds.length) throw new Error("register width mismatch");
    ls.forEach((l, i) => this.setD(l, ds[i]!));
  }

  /** Reference another circuit (TAP-02 REF). Returns its output signals. */
  ref(target: RefTarget, ins: Sig[], label = target.name ?? "ref"): Sig[] {
    if (ins.length !== target.nIn) throw new Error(`REF ${label}: ${ins.length} inputs for a circuit with ${target.nIn}`);
    if (target.nIn > 255 || target.nOut > 255) throw new Error("REF targets take at most 255 inputs and outputs");
    const call: RefCall = { target, ins: ins.slice(), outs: [], label };
    const index = this.refCalls.length;
    this.refCalls.push(call);
    for (let k = 0; k < target.nOut; k++) call.outs.push(this.node(KIND_REFOUT, index, k));
    return call.outs;
  }

  /** Emit the netlist. `outputs` become the last signals, in order. */
  build(outputs: Sig[]): BuildResult {
    if (outputs.length === 0) throw new Error("a circuit needs at least one output");
    for (let i = 0; i < this.kind.length; i++) {
      if (this.kind[i] === KIND_LATCH && !this.latchD.has(i)) throw new Error(`LATCH ${i} has no input`);
    }
    // Liveness from the outputs, through LATCH inputs and REF inputs.
    const live = new Uint8Array(this.kind.length);
    const refLive = new Uint8Array(this.refCalls.length);
    const stack = outputs.slice();
    while (stack.length) {
      const s = stack.pop()!;
      if (live[s]) continue;
      live[s] = 1;
      const k = this.kind[s];
      if (k === KIND_NAND) stack.push(this.a[s]!, this.b[s]!);
      else if (k === KIND_LATCH) stack.push(this.latchD.get(s)!);
      else if (k === KIND_REFOUT) {
        const r = this.a[s]!;
        if (!refLive[r]) {
          refLive[r] = 1;
          stack.push(...this.refCalls[r]!.ins);
        }
      }
    }
    // Consumers that pin a NAND in place (a later NAND or REF reads it).
    const pinned = new Uint8Array(this.kind.length);
    for (let s = 0; s < this.kind.length; s++) {
      if (!live[s]) continue;
      if (this.kind[s] === KIND_NAND) {
        pinned[this.a[s]!] = 1;
        pinned[this.b[s]!] = 1;
      }
    }
    this.refCalls.forEach((r, i) => {
      if (refLive[i]) for (const x of r.ins) pinned[x] = 1;
    });
    // Outputs that can move to the end: unpinned NANDs, each used once among the outputs.
    const seen = new Map<Sig, number>();
    for (const o of outputs) seen.set(o, (seen.get(o) ?? 0) + 1);
    const moved = new Set<Sig>();
    for (const o of outputs) {
      if (this.kind[o] === KIND_NAND && !pinned[o] && seen.get(o) === 1) moved.add(o);
    }

    // Assign TAP-02 signal indices.
    const index = new Int32Array(this.kind.length).fill(-1);
    index[0] = 0;
    index[1] = 1;
    this.inputs.forEach((s, i) => (index[s] = 2 + i));
    let next = 2 + this.inputs.length;
    type Pending =
      | { kind: "nand"; s: Sig }
      | { kind: "latch"; s: Sig }
      | { kind: "ref"; r: number };
    const order: Pending[] = [];
    const refEmitted = new Uint8Array(this.refCalls.length);
    for (let s = 2; s < this.kind.length; s++) {
      if (!live[s] || moved.has(s)) continue;
      const k = this.kind[s];
      if (k === KIND_NAND) order.push({ kind: "nand", s });
      else if (k === KIND_LATCH) order.push({ kind: "latch", s });
      else if (k === KIND_REFOUT) {
        const r = this.a[s]!;
        if (!refEmitted[r]) {
          refEmitted[r] = 1;
          order.push({ kind: "ref", r });
        }
      }
    }
    for (const p of order) {
      if (p.kind === "ref") {
        for (const o of this.refCalls[p.r]!.outs) index[o] = next++;
      } else {
        index[p.s] = next++;
      }
    }
    // Outputs must be the last signals, in order (TAP-02 §2). An output that cannot move gets a final gate of its
    // own: NAND(NOT x, NOT x) when NOT x already exists, else an inverter placed before all final gates.
    type Final = { kind: "moved"; s: Sig } | { kind: "const"; v: 0 | 1 } | { kind: "inv"; of: Sig } | { kind: "pre"; x: Sig };
    const finals: Final[] = outputs.map((o) => {
      if (moved.has(o)) return { kind: "moved", s: o };
      if (o === 0 || o === 1) return { kind: "const", v: o };
      const inv = this.liveInverse(o, live);
      // An inverter that is itself moved to the end is not available yet.
      return inv !== undefined && !moved.has(inv) ? { kind: "inv", of: inv } : { kind: "pre", x: o };
    });
    const preIndex = new Map<Sig, number>();
    for (const f of finals) if (f.kind === "pre" && !preIndex.has(f.x)) preIndex.set(f.x, next++);
    for (const f of finals) {
      if (f.kind === "moved") index[f.s] = next++;
      else next++;
    }

    // Encode records.
    const els: Element[] = [];
    const regions: string[] = [];
    const refLabels: string[] = [];
    let sig = 2 + this.inputs.length;
    const idx = (s: Sig): number => {
      const v = index[s]!;
      if (v < 0) throw new Error(`internal: signal ${s} has no index`);
      return v;
    };
    let nand = 0;
    let latch = 0;
    for (const p of order) {
      if (p.kind === "nand") {
        els.push({ op: OP_NAND, a: idx(this.a[p.s]!), b: idx(this.b[p.s]!), out: sig++ });
        regions.push(this.regionOf[p.s]!);
        nand++;
      } else if (p.kind === "latch") {
        els.push({ op: OP_LATCH, d: idx(this.latchD.get(p.s)!), out: sig++ });
        regions.push(this.regionOf[p.s]!);
        latch++;
      } else {
        const r = this.refCalls[p.r]!;
        els.push({
          op: OP_REF,
          cpu: r.target.cpu.toLowerCase(),
          id: r.target.id,
          ins: r.ins.map(idx),
          nOut: r.target.nOut,
          out: sig,
        });
        sig += r.target.nOut;
        regions.push(r.label);
        refLabels.push(r.label);
      }
    }
    for (const [x, at] of preIndex) {
      const j = idx(x);
      els.push({ op: OP_NAND, a: j, b: j, out: at });
      regions.push("output");
      sig++;
      nand++;
    }
    for (const f of finals) {
      let a: number;
      let b: number;
      if (f.kind === "moved") {
        a = idx(this.a[f.s]!);
        b = idx(this.b[f.s]!);
      } else if (f.kind === "const") {
        a = b = f.v === 0 ? 1 : 0;
      } else if (f.kind === "inv") {
        a = b = idx(f.of);
      } else {
        a = b = preIndex.get(f.x)!;
      }
      els.push({ op: OP_NAND, a, b, out: sig++ });
      regions.push(f.kind === "moved" ? this.regionOf[f.s]! : "output");
      nand++;
    }
    const refs = els.filter((e) => e.op === OP_REF).length;
    return {
      bytes: encode(els),
      elements: els,
      nIn: this.inputs.length,
      nOut: outputs.length,
      nand,
      latch,
      refs,
      refLabels,
      regions,
    };
  }

  /** A live gate that already holds NOT x, if any. */
  private liveInverse(x: Sig, live: Uint8Array): Sig | undefined {
    const a = this.notOf.get(x);
    if (a !== undefined && live[a]) return a;
    const b = this.isNot.get(x);
    if (b !== undefined && live[b]) return b;
    return undefined;
  }
}
