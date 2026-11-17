import fc from "fast-check";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Circuit,
  type Element,
  IllFormed,
  OP_LATCH,
  OP_NAND,
  OP_REF,
  beat,
  bitsToInt,
  bytesToHex,
  decode,
  encode,
  hexToBytes,
  intToBits,
  load,
  pack,
  refKey,
  unpack,
} from "../src/core/tap02";

interface RefSpec {
  cpu: string;
  id: number;
  nIn: number;
  nOut: number;
  netlist: string;
}
interface Vector {
  name: string;
  nIn: number;
  nOut: number;
  nState?: number;
  netlist: string;
  refs: RefSpec[];
  truthTable?: Array<{ inputs: string; outputs: string }>;
  beats?: Array<{ inputs: string; state: string; newState: string; outputs: string }>;
  reason?: string;
}
const vectors = JSON.parse(readFileSync(new URL("../third_party/tap-02/vectors.json", import.meta.url), "utf8")) as {
  valid: Vector[];
  illFormed: Vector[];
  packingEdgeCases: { circuit: string; cases: Array<{ case: string; inputs: string; outputs: string }> };
};

function resolverFor(refs: RefSpec[]) {
  const map = new Map<string, Circuit>();
  for (const r of refs) map.set(refKey(r.cpu, BigInt(r.id)), load(hexToBytes(r.netlist), r.nIn, r.nOut));
  return (cpu: string, id: bigint) => map.get(refKey(cpu, id));
}

function loadVector(v: Vector): Circuit {
  return load(hexToBytes(v.netlist), v.nIn, v.nOut, resolverFor(v.refs));
}

describe("TAP-02 published test vectors", () => {
  it.each(vectors.valid.filter((v) => v.truthTable).map((v) => [v.name, v] as const))(
    "%s: every row of the truth table matches",
    (_name, v) => {
      const c = loadVector(v);
      for (const row of v.truthTable!) {
        const r = beat(c, new Uint8Array(0), unpack(hexToBytes(row.inputs), c.nIn));
        expect(bytesToHex(pack(r.outputs)).slice(2)).toBe(row.outputs);
      }
    },
  );

  it.each(vectors.valid.filter((v) => v.beats).map((v) => [v.name, v] as const))(
    "%s: every beat gives the published new state and outputs",
    (_name, v) => {
      const c = loadVector(v);
      expect(c.nState).toBe(v.nState);
      for (const b of v.beats!) {
        const r = beat(c, unpack(hexToBytes(b.state), c.nState), unpack(hexToBytes(b.inputs), c.nIn));
        expect(bytesToHex(pack(r.newState)).slice(2)).toBe(b.newState);
        expect(bytesToHex(pack(r.outputs)).slice(2)).toBe(b.outputs);
      }
    },
  );

  it.each(vectors.illFormed.map((v) => [v.name, v] as const))("%s is rejected with the reference reason", (_n, v) => {
    expect(() => loadVector(v)).toThrow(IllFormed);
    expect(() => loadVector(v)).toThrow(v.reason!);
  });

  it.each(vectors.packingEdgeCases.cases.map((c) => [c.case, c] as const))(
    "packing edge case: %s reads inputs as the contracts do",
    (_n, pc) => {
      const v = vectors.valid.find((x) => x.name === vectors.packingEdgeCases.circuit)!;
      const c = loadVector(v);
      const r = beat(c, new Uint8Array(0), unpack(hexToBytes(pc.inputs), c.nIn));
      expect(bytesToHex(pack(r.outputs)).slice(2)).toBe(pc.outputs);
    },
  );

  it("decodes and re-encodes every published netlist to the same bytes", () => {
    for (const v of [...vectors.valid]) {
      const bytes = hexToBytes(v.netlist);
      expect(bytesToHex(encode(decode(bytes, v.nIn)))).toBe(v.netlist.toLowerCase());
    }
  });

  it("the on-chain popcount circuit #3151 counts the bits of all 256 inputs", () => {
    const v = vectors.valid.find((x) => x.name === "popcount8_3151")!;
    const c = loadVector(v);
    for (let x = 0; x < 256; x++) {
      const r = beat(c, new Uint8Array(0), intToBits(x, 8));
      expect(bitsToInt(r.outputs)).toBe(x.toString(2).split("1").length - 1);
    }
  });
});

describe("decoding", () => {
  it("reads REF records with their processor, id and pins", () => {
    const els = decode(hexToBytes("0x02" + "ab".repeat(20) + "0000000000000007" + "0201" + "000002" + "000003"), 2);
    expect(els).toEqual([{ op: OP_REF, cpu: "0x" + "ab".repeat(20), id: 7n, ins: [2, 3], nOut: 1, out: 4 }]);
  });

  it("rejects a REF record cut inside its header", () => {
    expect(() => decode(hexToBytes("0x02" + "ab".repeat(10)), 0)).toThrow("truncated record at byte 1");
  });

  it("numbers signals after the inputs, in record order", () => {
    const els = decode(hexToBytes("0x00000000000001" + "01000002"), 3);
    expect(els.map((e) => e.out)).toEqual([5, 6]);
  });

  it("refuses to encode a signal index outside u24", () => {
    expect(() => encode([{ op: OP_NAND, a: 1 << 24, b: 0, out: 2 }])).toThrow(IllFormed);
  });

  it("refuses to encode a REF with a malformed processor address", () => {
    expect(() => encode([{ op: OP_REF, cpu: "0x1234", id: 1n, ins: [], nOut: 1, out: 2 }])).toThrow(
      "REF processor address must be 20 bytes",
    );
  });

  it("rejects hex strings that are not hex", () => {
    expect(() => hexToBytes("0xzz")).toThrow();
    expect(() => hexToBytes("0x123")).toThrow();
  });
});

describe("well-formedness", () => {
  it("lets a LATCH refer forward but not past the last signal", () => {
    expect(load(hexToBytes("0x01000003" + "00000002000002"), 1, 1).nState).toBe(1);
    expect(() => load(hexToBytes("0x01000009" + "00000002000002"), 1, 1)).toThrow("is not available");
  });

  it("refuses a REF when no resolver is given", () => {
    const bytes = hexToBytes("0x02" + "aa".repeat(20) + "0000000000000001" + "0101" + "000002");
    expect(() => load(bytes, 1, 1)).toThrow("REF without a resolver");
  });

  it("counts gates through REF but burns only top-level records", () => {
    const toggle = vectors.valid.find((v) => v.name === "ref_with_state")!;
    const c = loadVector(toggle);
    expect(c.ownGates).toBe(2);
    expect(c.nGates).toBe(2 + 5);
  });

  it("refuses inputs or state of the wrong length in the evaluator", () => {
    const c = loadVector(vectors.valid.find((v) => v.name === "nand")!);
    expect(() => beat(c, new Uint8Array(1), new Uint8Array(2))).toThrow("length mismatch");
  });
});

/** A random well-formed netlist without REF. */
const netlistArb = fc
  .record({
    nIn: fc.integer({ min: 0, max: 6 }),
    ops: fc.array(fc.tuple(fc.boolean(), fc.nat(), fc.nat()), { minLength: 1, maxLength: 60 }),
    nOut: fc.integer({ min: 1, max: 4 }),
  })
  .map(({ nIn, ops, nOut }) => {
    const els: Element[] = [];
    let next = 2 + nIn;
    const total = 2 + nIn + ops.length;
    for (const [isLatch, x, y] of ops) {
      if (isLatch) els.push({ op: OP_LATCH, d: x % total, out: next });
      else els.push({ op: OP_NAND, a: x % next, b: y % next, out: next });
      next++;
    }
    return { nIn, nOut: Math.min(nOut, ops.length), els };
  });

describe("properties", () => {
  it("encode then decode returns the same records", () => {
    fc.assert(
      fc.property(netlistArb, ({ nIn, els }) => {
        expect(decode(encode(els), nIn)).toEqual(els);
      }),
    );
  });

  it("pack then unpack returns the same bits, and pack is ceil(n/8) bytes", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 1 }), { maxLength: 70 }), (bits) => {
        const p = pack(bits);
        expect(p.length).toBe(Math.ceil(bits.length / 8));
        expect(Array.from(unpack(p, bits.length))).toEqual(bits);
      }),
    );
  });

  it("a beat never reads past the state it was given and leaves it unchanged", () => {
    fc.assert(
      fc.property(netlistArb, fc.integer({ min: 0, max: 2 ** 30 }), ({ nIn, nOut, els }, seed) => {
        const c = load(encode(els), nIn, nOut);
        const state = intToBits(seed % 2 ** Math.min(c.nState, 30), c.nState);
        const before = state.slice();
        const r = beat(c, state, intToBits(seed % 2 ** nIn, nIn));
        expect(Array.from(state)).toEqual(Array.from(before));
        expect(r.newState.length).toBe(c.nState);
        expect(r.outputs.length).toBe(nOut);
      }),
    );
  });

  it("bitsToInt and intToBits are inverse", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), (x) => {
        expect(bitsToInt(intToBits(x, 31))).toBe(x);
      }),
    );
  });
});
