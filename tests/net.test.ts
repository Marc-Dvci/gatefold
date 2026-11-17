import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { add, decIf, eqConst, geConst, incIf, isZero, konst, muxWord, resize, rom, shr, sub, sumWords } from "../src/core/arith";
import { Net, type Sig } from "../src/core/net";
import { OP_NAND, OP_REF, beat, bitsToInt, intToBits, load } from "../src/core/tap02";

/** Evaluate a built combinational circuit on an integer input. */
function evalComb(n: Net, outs: Sig[], x: number): number {
  const b = n.build(outs);
  const c = load(b.bytes, b.nIn, b.nOut);
  return bitsToInt(beat(c, new Uint8Array(c.nState), intToBits(x, b.nIn)).outputs);
}

describe("gate builder", () => {
  it("folds constants and double inversions instead of emitting gates", () => {
    const n = new Net();
    const x = n.input();
    expect(n.nand(x, 0)).toBe(1);
    expect(n.nand(1, 1)).toBe(0);
    expect(n.not(n.not(x))).toBe(x);
    expect(n.nand(x, n.not(x))).toBe(1);
    expect(n.and(x, 1)).toBe(x);
    expect(n.or(x, 0)).toBe(x);
    expect(n.xor(x, x)).toBe(0);
    expect(n.mux(x, 1, 0)).toBe(x);
  });

  it("shares identical gates", () => {
    const n = new Net();
    const [a, b] = n.inputs_(2);
    expect(n.nand(a!, b!)).toBe(n.nand(b!, a!));
    expect(n.xor(a!, b!)).toBe(n.xor(a!, b!));
  });

  it("places the outputs as the last signals, in order, whatever produced them", () => {
    const n = new Net();
    const [a, b] = n.inputs_(2);
    const t = n.nand(a!, b!);
    const u = n.and(t, a!); // t is used by another gate, so it needs a buffer
    const outs = [a!, t, u, 1, 0, t];
    const built = n.build(outs);
    const c = load(built.bytes, built.nIn, built.nOut);
    for (let x = 0; x < 4; x++) {
      const [av, bv] = [x & 1, x >> 1];
      const tv = 1 - (av & bv);
      const r = beat(c, new Uint8Array(0), intToBits(x, 2));
      expect(Array.from(r.outputs)).toEqual([av, tv, tv & av, 1, 0, tv]);
    }
  });

  it("drops gates that reach no output", () => {
    const n = new Net();
    const [a, b] = n.inputs_(2);
    n.xor(a!, b!); // unused
    const built = n.build([n.nand(a!, b!)]);
    expect(built.nand).toBe(1);
  });

  it("keeps a LATCH only when an output depends on it, and lets it refer forward", () => {
    const n = new Net();
    const en = n.input();
    const q = n.latch();
    const nx = n.xor(q, en);
    n.setD(q, nx);
    const unused = n.latch();
    n.setD(unused, en);
    const built = n.build([nx]);
    expect(built.latch).toBe(1);
    const c = load(built.bytes, built.nIn, built.nOut);
    let st: Uint8Array = new Uint8Array(1);
    const seen: number[] = [];
    for (let t = 0; t < 4; t++) {
      const r = beat(c, st, new Uint8Array([1]));
      st = r.newState;
      seen.push(r.outputs[0]!);
    }
    expect(seen).toEqual([1, 0, 1, 0]);
  });

  it("refuses a LATCH without an input, or one set twice", () => {
    const n = new Net();
    const q = n.latch();
    expect(() => n.build([q])).toThrow("has no input");
    n.setD(q, 1);
    expect(() => n.setD(q, 0)).toThrow("already set");
    expect(() => n.setD(n.input(), 0)).toThrow("not a LATCH");
  });

  it("emits a REF record with the target's pins and checks arity", () => {
    const n = new Net();
    const x = n.input();
    const target = { cpu: "0x" + "22".repeat(20), id: 9n, nIn: 1, nOut: 2, name: "sub" };
    expect(() => n.ref(target, [x, x])).toThrow("2 inputs for a circuit with 1");
    const [o1, o2] = n.ref(target, [x], "voice");
    const built = n.build([n.and(o1!, o2!)]);
    const r = built.elements.find((e) => e.op === OP_REF)!;
    expect(r).toMatchObject({ op: OP_REF, cpu: target.cpu, id: 9n, nOut: 2, ins: [2] });
    expect(built.refLabels).toEqual(["voice"]);
    expect(built.elements.at(-1)!.op).toBe(OP_NAND);
  });

  it("refuses a circuit with no outputs", () => {
    expect(() => new Net().build([])).toThrow();
  });

  it("random boolean expressions evaluate as JavaScript says", () => {
    type Expr = { op: "in"; i: number } | { op: "nand" | "and" | "or" | "xor"; l: Expr; r: Expr } | { op: "not"; e: Expr };
    const exprArb = fc.letrec<{ e: Expr }>((tie) => ({
      e: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.record({ op: fc.constant("in" as const), i: fc.integer({ min: 0, max: 3 }) }),
        fc.record({ op: fc.constantFrom("nand" as const, "and" as const, "or" as const, "xor" as const), l: tie("e"), r: tie("e") }),
        fc.record({ op: fc.constant("not" as const), e: tie("e") }),
      ),
    })).e;
    const js = (e: Expr, x: number): number => {
      switch (e.op) {
        case "in":
          return (x >> e.i) & 1;
        case "not":
          return 1 - js(e.e, x);
        case "nand":
          return 1 - (js(e.l, x) & js(e.r, x));
        case "and":
          return js(e.l, x) & js(e.r, x);
        case "or":
          return js(e.l, x) | js(e.r, x);
        default:
          return js(e.l, x) ^ js(e.r, x);
      }
    };
    fc.assert(
      fc.property(exprArb, (e) => {
        const n = new Net();
        const ins = n.inputs_(4);
        const build = (q: Expr): Sig => {
          switch (q.op) {
            case "in":
              return ins[q.i]!;
            case "not":
              return n.not(build(q.e));
            case "nand":
              return n.nand(build(q.l), build(q.r));
            case "and":
              return n.and(build(q.l), build(q.r));
            case "or":
              return n.or(build(q.l), build(q.r));
            default:
              return n.xor(build(q.l), build(q.r));
          }
        };
        const out = build(e);
        const b = n.build([out]);
        const c = load(b.bytes, b.nIn, b.nOut);
        for (let x = 0; x < 16; x++) expect(beat(c, new Uint8Array(0), intToBits(x, 4)).outputs[0]).toBe(js(e, x));
      }),
      { numRuns: 300 },
    );
  });
});

describe("word-level blocks, checked exhaustively", () => {
  it("add and sub over 4-bit words", () => {
    for (let a = 0; a < 16; a++)
      for (let b = 0; b < 16; b++) {
        const n = new Net();
        const A = n.inputs_(4);
        const B = n.inputs_(4);
        const s = add(n, A, B);
        const d = sub(n, A, B);
        const v = evalComb(n, [...s.sum, s.carry, ...d.diff, d.borrow], a | (b << 4));
        expect(v & 31).toBe(a + b);
        expect((v >> 5) & 15).toBe((a - b + 16) % 16);
        expect(v >> 9).toBe(b > a ? 1 : 0);
      }
  });

  it("increment and decrement when enabled, and hold when not", () => {
    for (let a = 0; a < 32; a++)
      for (const en of [0, 1]) {
        const n = new Net();
        const A = n.inputs_(5);
        const e = n.input();
        const v = evalComb(n, [...incIf(n, A, e), ...decIf(n, A, e)], a | (en << 5));
        expect(v & 31).toBe((a + en) % 32);
        expect(v >> 5).toBe((a - en + 32) % 32);
      }
  });

  it("comparisons with constants at every boundary", () => {
    for (let k = -1; k <= 33; k++)
      for (let a = 0; a < 32; a++) {
        const n = new Net();
        const A = n.inputs_(5);
        const v = evalComb(n, [geConst(n, A, k), k >= 0 && k < 32 ? eqConst(n, A, k) : 0, isZero(n, A)], a);
        expect(v & 1).toBe(a >= k ? 1 : 0);
        expect((v >> 1) & 1).toBe(a === k ? 1 : 0);
        expect(v >> 2).toBe(a === 0 ? 1 : 0);
      }
  });

  it("multiplexers, shifts, resize and sums", () => {
    for (let x = 0; x < 64; x++) {
      const n = new Net();
      const s = n.input();
      const A = n.inputs_(3);
      const B = n.inputs_(2);
      const out = [...muxWord(n, s, A, B), ...shr(A, 1), ...resize(B, 3), ...sumWords(n, [A, B, konst(2, 3)])];
      const v = evalComb(n, out, x);
      const [sv, av, bv] = [x & 1, (x >> 1) & 7, x >> 4];
      expect(v & 7).toBe(sv ? av : bv);
      expect((v >> 3) & 7).toBe(av >> 1);
      expect((v >> 6) & 7).toBe(bv);
      expect(v >> 9).toBe(av + bv + 3);
    }
  });

  it("refuses constants that do not fit", () => {
    expect(() => konst(3, 8)).toThrow();
    expect(() => konst(3, -1)).toThrow();
  });
});

describe("ROM", () => {
  it("returns every stored word", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 32 }), (words) => {
        const bits = Math.max(1, Math.ceil(Math.log2(words.length)));
        for (let a = 0; a < words.length; a++) {
          const n = new Net();
          const A = n.inputs_(bits);
          expect(evalComb(n, rom(n, A, words, 8), a)).toBe(words[a]);
        }
      }),
      { numRuns: 40 },
    );
  });

  it("an aligned block that repeats costs no extra gates", () => {
    const block = [3, 9, 1, 14, 7, 7, 2, 11, 5, 0, 6, 13, 12, 4, 8, 15];
    const size = (words: number[]): number => {
      const n = new Net();
      const A = n.inputs_(Math.ceil(Math.log2(words.length)));
      return n.build(rom(n, A, words, 4)).nand;
    };
    const once = size([...block, ...block.map((x) => 15 - x)]);
    const repeated = size([...block, ...block.map((x) => 15 - x), ...block, ...block.map((x) => 15 - x)]);
    expect(repeated).toBeLessThanOrEqual(once + 2);
  });

  it("refuses more words than the address can reach", () => {
    const n = new Net();
    expect(() => rom(n, n.inputs_(2), [1, 2, 3, 4, 5], 3)).toThrow();
  });
});

describe("regressions", () => {
  it("an output whose inverse is another output still lands in its own last signal", () => {
    // ROM [60, 29]: bit 0 is the address and bit 5 its inverse, both outputs.
    const n = new Net();
    const A = n.inputs_(1);
    const outs = rom(n, A, [60, 29], 8);
    expect(evalComb(n, outs, 0)).toBe(60);
    const m = new Net();
    const B = m.inputs_(1);
    expect(evalComb(m, rom(m, B, [60, 29], 8), 1)).toBe(29);
  });
});
