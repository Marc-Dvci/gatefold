/**
 * Flattening and compilation of a TAP-02 circuit for fast playback.
 *
 * `flatten` inlines every REF instance (each instance keeps its own block of the state vector, TAP-02 §4), then
 * `simplify` folds constants, removes double inversions and drops gates that reach neither an output nor a LATCH.
 * Every LATCH is kept, so the full state vector, laid out exactly as TAP-02 §4 orders it, is computed on every beat
 * and can be sent to the chain's `step` for comparison at any moment.
 *
 * Two engines run the result: `FlatEngine` (a typed-array interpreter, no code generation) and `compileJs` (straight-
 * line JavaScript, one statement per gate). The tests hold both to the reference evaluator in `tap02.ts`.
 */
import { type Circuit, OP_LATCH, OP_NAND, refKey } from "./tap02";

/** Node kinds of a flat program. */
export const K_CONST0 = 0;
export const K_CONST1 = 1;
export const K_INPUT = 2;
export const K_NAND = 3;
export const K_LATCH = 4;
export const K_NOT = 5;

export interface Instance {
  /** "top" or the REF path, for example "top/0x…:3#2". */
  path: string;
  cpu: string | null;
  id: bigint | null;
  parent: number;
  /** First and last+1 state bits of this instance's block. */
  stateStart: number;
  stateEnd: number;
}

export interface FlatProgram {
  nIn: number;
  nOut: number;
  nState: number;
  /** Per node: kind, operands (NAND: a, b; NOT: a; INPUT: input index; LATCH: state bit). */
  kind: Uint8Array;
  a: Int32Array;
  b: Int32Array;
  /** Per node: the instance (module) that produced it, for the die view. */
  owner: Int32Array;
  /** For each state bit, the node whose value the LATCH stores at the end of a beat. */
  latchD: Int32Array;
  /** For each state bit, the node that reads it (its LATCH). */
  latchNode: Int32Array;
  outputs: Int32Array;
  instances: Instance[];
}

/** Inline every REF instance. Node ids follow evaluation order. */
export function flatten(c: Circuit): FlatProgram {
  const kind: number[] = [K_CONST0, K_CONST1];
  const a: number[] = [0, 0];
  const b: number[] = [0, 0];
  const owner: number[] = [0, 0];
  const latchD = new Int32Array(c.nState).fill(-1);
  const latchNode = new Int32Array(c.nState).fill(-1);
  const instances: Instance[] = [];
  const push = (k: number, x: number, y: number, inst: number): number => {
    kind.push(k);
    a.push(x);
    b.push(y);
    owner.push(inst);
    return kind.length - 1;
  };
  const top = 0;
  instances.push({ path: "top", cpu: null, id: null, parent: -1, stateStart: 0, stateEnd: c.nState });
  const inputs: number[] = [];
  for (let i = 0; i < c.nIn; i++) inputs.push(push(K_INPUT, i, 0, top));

  const inline = (circ: Circuit, ins: number[], stateOffset: number, inst: number): number[] => {
    const local = new Int32Array(circ.nSignals);
    local[0] = 0;
    local[1] = 1;
    for (let i = 0; i < circ.nIn; i++) local[2 + i] = ins[i]!;
    const pendingLatches: Array<[number, number]> = [];
    let refCount = 0;
    circ.elements.forEach((e, idx) => {
      const base = stateOffset + circ.stateBase[idx]!;
      if (e.op === OP_NAND) {
        local[e.out] = push(K_NAND, local[e.a]!, local[e.b]!, inst);
      } else if (e.op === OP_LATCH) {
        const n = push(K_LATCH, base, 0, inst);
        local[e.out] = n;
        latchNode[base] = n;
        pendingLatches.push([base, e.d]);
      } else {
        const sub = circ.subs.get(refKey(e.cpu, e.id))!;
        const child = instances.length;
        instances.push({
          path: `${instances[inst]!.path}/${e.cpu}:${e.id}#${refCount++}`,
          cpu: e.cpu,
          id: e.id,
          parent: inst,
          stateStart: base,
          stateEnd: base + sub.nState,
        });
        const outs = inline(
          sub,
          e.ins.map((s) => local[s]!),
          base,
          child,
        );
        for (let k = 0; k < outs.length; k++) local[e.out + k] = outs[k]!;
      }
    });
    for (const [bit, d] of pendingLatches) latchD[bit] = local[d]!;
    const outs: number[] = [];
    for (let i = circ.nSignals - circ.nOut; i < circ.nSignals; i++) outs.push(local[i]!);
    return outs;
  };

  const outputs = inline(c, inputs, 0, top);
  return {
    nIn: c.nIn,
    nOut: c.nOut,
    nState: c.nState,
    kind: Uint8Array.from(kind),
    a: Int32Array.from(a),
    b: Int32Array.from(b),
    owner: Int32Array.from(owner),
    latchD,
    latchNode,
    outputs: Int32Array.from(outputs),
    instances,
  };
}

/**
 * Fold constants (NAND with 0 is 1, NAND with 1 is NOT), turn NAND(x, x) into NOT x, remove double inversions,
 * share identical gates, and drop nodes that reach neither an output nor a LATCH. Outputs and the full new state are
 * unchanged for every state and input.
 */
export function simplify(p: FlatProgram): FlatProgram {
  const n = p.kind.length;
  // rep[i]: the node that now stands for node i (after folding), as an index into the old node list.
  const rep = new Int32Array(n);
  const kind = p.kind.slice();
  const a = p.a.slice();
  const b = p.b.slice();
  const table = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    rep[i] = i;
    const k = kind[i]!;
    if (k === K_NAND) {
      let x = rep[a[i]!]!;
      let y = rep[b[i]!]!;
      if (x > y) [x, y] = [y, x];
      const kx = kind[x]!;
      const ky = kind[y]!;
      if (kx === K_CONST0 || ky === K_CONST0) {
        rep[i] = 1;
        continue;
      }
      if (kx === K_CONST1 && ky === K_CONST1) {
        rep[i] = 0;
        continue;
      }
      // NOT of something: NAND(1, y) or NAND(y, y).
      let notOf = -1;
      if (kx === K_CONST1) notOf = y;
      else if (ky === K_CONST1) notOf = x;
      else if (x === y) notOf = x;
      if (notOf >= 0) {
        if (kind[notOf] === K_NOT) {
          rep[i] = a[notOf]!;
          continue;
        }
        const key = `n${notOf}`;
        const hit = table.get(key);
        if (hit !== undefined) {
          rep[i] = hit;
          continue;
        }
        kind[i] = K_NOT;
        a[i] = notOf;
        b[i] = 0;
        table.set(key, i);
        continue;
      }
      // NAND(x, NOT x) is always 1.
      if ((kind[x] === K_NOT && a[x] === y) || (kind[y] === K_NOT && a[y] === x)) {
        rep[i] = 1;
        continue;
      }
      const key = `${x},${y}`;
      const hit = table.get(key);
      if (hit !== undefined) {
        rep[i] = hit;
        continue;
      }
      a[i] = x;
      b[i] = y;
      table.set(key, i);
    }
  }
  const latchD = Int32Array.from(p.latchD, (d) => rep[d]!);
  const outputs = Int32Array.from(p.outputs, (o) => rep[o]!);

  // Liveness from outputs and every LATCH input.
  const live = new Uint8Array(n);
  const stack: number[] = [...outputs, ...latchD];
  while (stack.length) {
    const i = stack.pop()!;
    if (live[i]) continue;
    live[i] = 1;
    if (kind[i] === K_NAND) stack.push(a[i]!, b[i]!);
    else if (kind[i] === K_NOT) stack.push(a[i]!);
  }
  // Compact: keep constants, inputs, latches and live gates, in order.
  const keep: number[] = [];
  const newId = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (rep[i] !== i) continue;
    const k = kind[i]!;
    const kept = i <= 1 || k === K_INPUT || k === K_LATCH || live[i] === 1;
    if (!kept) continue;
    newId[i] = keep.length;
    keep.push(i);
  }
  const m = keep.length;
  const out: FlatProgram = {
    nIn: p.nIn,
    nOut: p.nOut,
    nState: p.nState,
    kind: new Uint8Array(m),
    a: new Int32Array(m),
    b: new Int32Array(m),
    owner: new Int32Array(m),
    latchD: Int32Array.from(latchD, (d) => newId[d]!),
    latchNode: Int32Array.from(p.latchNode, (l) => newId[l]!),
    outputs: Int32Array.from(outputs, (o) => newId[o]!),
    instances: p.instances,
  };
  keep.forEach((old, j) => {
    const k = kind[old]!;
    out.kind[j] = k;
    out.owner[j] = p.owner[old]!;
    if (k === K_NAND) {
      out.a[j] = newId[a[old]!]!;
      out.b[j] = newId[b[old]!]!;
    } else if (k === K_NOT) {
      out.a[j] = newId[a[old]!]!;
    } else {
      out.a[j] = a[old]!;
    }
  });
  return out;
}

/** Gate count of a flat program (NAND and NOT nodes). */
export function gateCount(p: FlatProgram): number {
  let g = 0;
  for (const k of p.kind) if (k === K_NAND || k === K_NOT) g++;
  return g;
}

/** An engine runs beats with its own state vector, laid out as TAP-02 §4 orders it. */
export interface Engine {
  readonly nIn: number;
  readonly nOut: number;
  readonly nState: number;
  /** Current state, one bit per entry. Writable: set it to replay from any state. */
  state: Uint8Array;
  /** Run `n` beats with constant inputs; out[t] receives the outputs packed LSB first (nOut must be at most 31). */
  run(n: number, inputs: Uint8Array, out: Int32Array, offset?: number): void;
  /** One beat with every node's value written to `signals` (for the die view). Advances the state. */
  probe(inputs: Uint8Array, signals: Uint8Array): number;
}

/** A typed-array interpreter over the flat program. No code generation, so it runs where `eval` is not allowed. */
export class FlatEngine implements Engine {
  readonly nIn: number;
  readonly nOut: number;
  readonly nState: number;
  state: Uint8Array;
  private readonly sig: Uint8Array;

  constructor(private readonly p: FlatProgram) {
    if (p.nOut > 31) throw new Error("FlatEngine packs at most 31 outputs per beat");
    this.nIn = p.nIn;
    this.nOut = p.nOut;
    this.nState = p.nState;
    this.state = new Uint8Array(p.nState);
    this.sig = new Uint8Array(p.kind.length);
  }

  private step(inputs: Uint8Array, sig: Uint8Array): number {
    const { kind, a, b, latchD, outputs } = this.p;
    const st = this.state;
    const n = kind.length;
    sig[0] = 0;
    sig[1] = 1;
    for (let i = 2; i < n; i++) {
      switch (kind[i]) {
        case K_NAND:
          sig[i] = 1 ^ (sig[a[i]!]! & sig[b[i]!]!);
          break;
        case K_NOT:
          sig[i] = 1 ^ sig[a[i]!]!;
          break;
        case K_INPUT:
          sig[i] = inputs[a[i]!]! & 1;
          break;
        case K_LATCH:
          sig[i] = st[a[i]!]!;
          break;
        case K_CONST1:
          sig[i] = 1;
          break;
        default:
          sig[i] = 0;
      }
    }
    for (let s = 0; s < latchD.length; s++) st[s] = sig[latchD[s]!]!;
    let word = 0;
    for (let o = 0; o < outputs.length; o++) word |= sig[outputs[o]!]! << o;
    return word;
  }

  run(n: number, inputs: Uint8Array, out: Int32Array, offset = 0): void {
    for (let t = 0; t < n; t++) out[offset + t] = this.step(inputs, this.sig);
  }

  probe(inputs: Uint8Array, signals: Uint8Array): number {
    return this.step(inputs, signals);
  }
}

/** Generate the JavaScript source of a straight-line beat loop for the program. */
export function jsSource(p: FlatProgram): string {
  if (p.nOut > 31) throw new Error("compiled engines pack at most 31 outputs per beat");
  const { kind, a, b, latchD, outputs } = p;
  const n = kind.length;
  const expr = (i: number): string => {
    switch (kind[i]) {
      case K_CONST0:
        return "0";
      case K_CONST1:
        return "1";
      case K_INPUT:
        return `i${a[i]}`;
      case K_LATCH:
        return `s${a[i]}`;
      default:
        return `g${i}`;
    }
  };
  const lines: string[] = [];
  lines.push("const st = this.state;");
  for (let i = 0; i < p.nIn; i++) lines.push(`const i${i} = inp[${i}] & 1;`);
  for (let s = 0; s < p.nState; s++) lines.push(`let s${s} = st[${s}];`);
  lines.push("for (let t = 0; t < n; t++) {");
  const body: string[] = [];
  for (let i = 2; i < n; i++) {
    if (kind[i] === K_NAND) body.push(`const g${i} = 1 ^ (${expr(a[i]!)} & ${expr(b[i]!)});`);
    else if (kind[i] === K_NOT) body.push(`const g${i} = 1 ^ ${expr(a[i]!)};`);
  }
  // Latches that store another latch's old value need a copy before any update.
  const temps: string[] = [];
  const updates: string[] = [];
  for (let s = 0; s < latchD.length; s++) {
    const d = latchD[s]!;
    if (kind[d] === K_LATCH) {
      temps.push(`const t${s} = s${a[d]};`);
      updates.push(`s${s} = t${s};`);
    } else {
      updates.push(`s${s} = ${expr(d)};`);
    }
  }
  const word = Array.from(outputs, (o, k) => (k === 0 ? expr(o) : `(${expr(o)} << ${k})`)).join(" | ") || "0";
  body.push(`out[off + t] = ${word};`);
  body.push(...temps, ...updates);
  lines.push(...body.map((l) => "  " + l));
  lines.push("}");
  for (let s = 0; s < p.nState; s++) lines.push(`st[${s}] = s${s};`);
  return lines.join("\n");
}

/** Generate a one-beat function that writes every node's value (for the die view). */
export function jsProbeSource(p: FlatProgram): string {
  const { kind, a, b, latchD, outputs } = p;
  const n = kind.length;
  const lines: string[] = ["const st = this.state;", "const v = sig;", "v[0] = 0; v[1] = 1;"];
  for (let i = 2; i < n; i++) {
    switch (kind[i]) {
      case K_NAND:
        lines.push(`v[${i}] = 1 ^ (v[${a[i]}] & v[${b[i]}]);`);
        break;
      case K_NOT:
        lines.push(`v[${i}] = 1 ^ v[${a[i]}];`);
        break;
      case K_INPUT:
        lines.push(`v[${i}] = inp[${a[i]}] & 1;`);
        break;
      case K_LATCH:
        lines.push(`v[${i}] = st[${a[i]}];`);
        break;
      case K_CONST1:
        lines.push(`v[${i}] = 1;`);
        break;
      default:
        lines.push(`v[${i}] = 0;`);
    }
  }
  for (let s = 0; s < latchD.length; s++) lines.push(`st[${s}] = v[${latchD[s]}];`);
  const word = Array.from(outputs, (o, k) => `(v[${o}] << ${k})`).join(" | ") || "0";
  lines.push(`return ${word};`);
  return lines.join("\n");
}

/** Straight-line JavaScript engine. Uses `new Function`, so it needs a page that allows it. */
export class JsEngine implements Engine {
  readonly nIn: number;
  readonly nOut: number;
  readonly nState: number;
  state: Uint8Array;
  private readonly runFn: (n: number, inp: Uint8Array, out: Int32Array, off: number) => void;
  private readonly probeFn: (inp: Uint8Array, sig: Uint8Array) => number;

  constructor(p: FlatProgram) {
    this.nIn = p.nIn;
    this.nOut = p.nOut;
    this.nState = p.nState;
    this.state = new Uint8Array(p.nState);
    this.runFn = new Function("n", "inp", "out", "off", jsSource(p)) as typeof this.runFn;
    this.probeFn = new Function("inp", "sig", jsProbeSource(p)) as typeof this.probeFn;
  }

  run(n: number, inputs: Uint8Array, out: Int32Array, offset = 0): void {
    this.runFn.call(this, n, inputs, out, offset);
  }

  probe(inputs: Uint8Array, signals: Uint8Array): number {
    return this.probeFn.call(this, inputs, signals);
  }
}

/** True when this page may generate code (no Content Security Policy blocks `new Function`). */
export function canGenerateCode(): boolean {
  try {
    return new Function("return 1")() === 1;
  } catch {
    return false;
  }
}

/** The fastest engine this page allows. */
export function makeEngine(p: FlatProgram): Engine {
  return canGenerateCode() ? new JsEngine(p) : new FlatEngine(p);
}
