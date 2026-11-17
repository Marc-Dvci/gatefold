import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Engine,
  FlatEngine,
  JsEngine,
  K_LATCH,
  K_NOT,
  canGenerateCode,
  flatten,
  gateCount,
  jsSource,
  makeEngine,
  simplify,
} from "../src/core/flat";
import { type Circuit, type Element, OP_LATCH, OP_NAND, OP_REF, beat, bitsToInt, encode, intToBits, load, refKey } from "../src/core/tap02";

const SUB_CPU = "0x" + "11".repeat(20);

/** Random circuits, optionally referencing a random stateful sub-circuit twice. */
const circuitArb = fc
  .record({
    nIn: fc.integer({ min: 0, max: 5 }),
    subOps: fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.nat()), { minLength: 1, maxLength: 25 }),
    ops: fc.array(fc.tuple(fc.integer({ min: 0, max: 5 }), fc.nat(), fc.nat()), { minLength: 1, maxLength: 50 }),
    nOut: fc.integer({ min: 1, max: 6 }),
  })
  .map(({ nIn, subOps, ops, nOut }) => {
    // Sub-circuit: 2 inputs, 2 outputs.
    const subEls: Element[] = [];
    let next = 4;
    const subTotal = 4 + subOps.length + 2;
    for (const [isLatch, x, y] of subOps) {
      if (isLatch) subEls.push({ op: OP_LATCH, d: x % subTotal, out: next });
      else subEls.push({ op: OP_NAND, a: x % next, b: y % next, out: next });
      next++;
    }
    subEls.push({ op: OP_NAND, a: next - 1, b: 2, out: next });
    next++;
    subEls.push({ op: OP_NAND, a: next - 1, b: 3, out: next });
    const sub = load(encode(subEls), 2, 2);
    const els: Element[] = [];
    next = 2 + nIn;
    let latchCount = 0;
    for (const [k, x, y] of ops) {
      if (k === 0) {
        els.push({ op: OP_LATCH, d: 0, out: next });
        latchCount++;
        next++;
      } else if (k === 5) {
        els.push({ op: OP_REF, cpu: SUB_CPU, id: 1n, ins: [x % next, y % next], nOut: 2, out: next });
        next += 2;
      } else {
        els.push({ op: OP_NAND, a: x % next, b: y % next, out: next });
        next++;
      }
    }
    // Point LATCH inputs anywhere, forward included.
    let i = 0;
    for (const e of els) if (e.op === OP_LATCH) e.d = (ops[i++]![1] * 7 + e.out) % next;
    void latchCount;
    const resolve = (cpu: string, id: bigint) => (refKey(cpu, id) === refKey(SUB_CPU, 1n) ? sub : undefined);
    return load(encode(els), nIn, Math.min(nOut, next - 2 - nIn), resolve);
  });

function referenceRun(c: Circuit, state: Uint8Array, inputs: Uint8Array, n: number) {
  const outs: number[] = [];
  let st = state;
  for (let t = 0; t < n; t++) {
    const r = beat(c, st, inputs);
    st = r.newState;
    outs.push(bitsToInt(r.outputs));
  }
  return { outs, state: st };
}

function engineRun(e: Engine, state: Uint8Array, inputs: Uint8Array, n: number) {
  e.state = state.slice();
  const out = new Int32Array(n);
  e.run(n, inputs, out);
  return { outs: Array.from(out), state: e.state };
}

describe("compiled engines agree with the TAP-02 reference evaluator", () => {
  it("the typed-array interpreter, on random circuits with LATCH and REF, from random states", () => {
    fc.assert(
      fc.property(circuitArb, fc.nat(), fc.nat(), (c, s, x) => {
        const state = intToBits(s % 2 ** Math.min(c.nState, 30), c.nState);
        const inputs = intToBits(x % 2 ** c.nIn, c.nIn);
        const ref = referenceRun(c, state, inputs, 12);
        const got = engineRun(new FlatEngine(simplify(flatten(c))), state, inputs, 12);
        expect(got.outs).toEqual(ref.outs);
        expect(Array.from(got.state)).toEqual(Array.from(ref.state));
      }),
      { numRuns: 300 },
    );
  });

  it("the generated JavaScript, on the same circuits", () => {
    fc.assert(
      fc.property(circuitArb, fc.nat(), fc.nat(), (c, s, x) => {
        const state = intToBits(s % 2 ** Math.min(c.nState, 30), c.nState);
        const inputs = intToBits(x % 2 ** c.nIn, c.nIn);
        const ref = referenceRun(c, state, inputs, 12);
        const got = engineRun(new JsEngine(simplify(flatten(c))), state, inputs, 12);
        expect(got.outs).toEqual(ref.outs);
        expect(Array.from(got.state)).toEqual(Array.from(ref.state));
      }),
      { numRuns: 300 },
    );
  });

  it("without simplification too, so folding is not what makes them agree", () => {
    fc.assert(
      fc.property(circuitArb, fc.nat(), (c, x) => {
        const inputs = intToBits(x % 2 ** c.nIn, c.nIn);
        const ref = referenceRun(c, new Uint8Array(c.nState), inputs, 6);
        const got = engineRun(new JsEngine(flatten(c)), new Uint8Array(c.nState), inputs, 6);
        expect(got.outs).toEqual(ref.outs);
      }),
      { numRuns: 100 },
    );
  });

  it("probe writes every node and returns the same outputs as run", () => {
    fc.assert(
      fc.property(circuitArb, (c) => {
        const p = simplify(flatten(c));
        const a = new FlatEngine(p);
        const b = new JsEngine(p);
        const sigA = new Uint8Array(p.kind.length);
        const sigB = new Uint8Array(p.kind.length);
        const inputs = new Uint8Array(c.nIn).fill(1);
        for (let t = 0; t < 4; t++) {
          expect(b.probe(inputs, sigB)).toBe(a.probe(inputs, sigA));
          expect(Array.from(sigB)).toEqual(Array.from(sigA));
        }
        expect(Array.from(a.state)).toEqual(Array.from(b.state));
      }),
      { numRuns: 100 },
    );
  });
});

describe("flattening", () => {
  it("keeps the TAP-02 state layout: a REF instance owns a contiguous block after the LATCHes before it", () => {
    const toggle = load(new Uint8Array(encode([
      { op: OP_LATCH, d: 7, out: 3 },
      { op: OP_NAND, a: 3, b: 2, out: 4 },
      { op: OP_NAND, a: 3, b: 4, out: 5 },
      { op: OP_NAND, a: 2, b: 4, out: 6 },
      { op: OP_NAND, a: 5, b: 6, out: 7 },
    ])), 1, 1);
    const resolve = () => toggle;
    const top = load(encode([
      { op: OP_LATCH, d: 2, out: 3 },
      { op: OP_REF, cpu: SUB_CPU, id: 1n, ins: [2], nOut: 1, out: 4 },
      { op: OP_REF, cpu: SUB_CPU, id: 1n, ins: [3], nOut: 1, out: 5 },
      { op: OP_NAND, a: 4, b: 5, out: 6 },
    ]), 1, 1, resolve);
    const p = flatten(top);
    expect(p.nState).toBe(3);
    expect(p.instances.map((i) => [i.stateStart, i.stateEnd])).toEqual([[0, 3], [1, 2], [2, 3]]);
    expect(Array.from(p.latchNode).every((n) => p.kind[n] === K_LATCH)).toBe(true);
  });

  it("simplification keeps every LATCH and removes logic that reaches nothing", () => {
    const c = load(encode([
      { op: OP_NAND, a: 2, b: 2, out: 3 }, // dead
      { op: OP_LATCH, d: 2, out: 4 }, // unused latch: kept, since state is compared with the chain
      { op: OP_NAND, a: 2, b: 1, out: 5 }, // NOT x
      { op: OP_NAND, a: 5, b: 5, out: 6 }, // NOT NOT x = x
    ]), 1, 1);
    const p = simplify(flatten(c));
    expect(p.nState).toBe(1);
    expect(gateCount(p)).toBe(0);
    expect(Array.from(p.kind).filter((k) => k === K_NOT).length).toBe(0);
  });

  it("generated code reads like straight-line gates", () => {
    const c = load(encode([{ op: OP_NAND, a: 2, b: 3, out: 4 }]), 2, 1);
    expect(jsSource(flatten(c))).toContain("const g4 = 1 ^ (i0 & i1);");
  });

  it("refuses to pack more than 31 outputs into one word", () => {
    const els: Element[] = Array.from({ length: 32 }, (_, i) => ({ op: OP_NAND, a: 2, b: 2, out: 3 + i }) as Element);
    const c = load(encode(els), 1, 32);
    expect(() => new FlatEngine(flatten(c))).toThrow("31");
    expect(() => jsSource(flatten(c))).toThrow("31");
  });

  it("chooses the generated-code engine where the page allows it", () => {
    const c = load(encode([{ op: OP_NAND, a: 2, b: 2, out: 3 }]), 1, 1);
    expect(canGenerateCode()).toBe(true);
    expect(makeEngine(flatten(c))).toBeInstanceOf(JsEngine);
  });
});
