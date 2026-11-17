/**
 * Word-level building blocks on top of `Net`: adders, counters, comparators with constants, multiplexers and ROMs.
 * Words are arrays of signals, least significant bit first (the TAP-02 packing order).
 */
import type { Net, Sig } from "./net";

export type Word = Sig[];

/** A constant as a word of `width` bits. */
export function konst(width: number, value: number): Word {
  if (value < 0 || value >= 2 ** width) throw new Error(`constant ${value} does not fit in ${width} bits`);
  return Array.from({ length: width }, (_, i) => (Math.floor(value / 2 ** i) % 2 === 1 ? 1 : 0));
}

/** Zero-extend or truncate a word to `width` bits. */
export function resize(w: Word, width: number): Word {
  return Array.from({ length: width }, (_, i) => (i < w.length ? w[i]! : 0));
}

/** A full adder from nine NAND gates. Returns [sum, carry]. Constant inputs fold away. */
export function fullAdder(n: Net, a: Sig, b: Sig, c: Sig): [Sig, Sig] {
  const t1 = n.nand(a, b);
  const t2 = n.nand(a, t1);
  const t3 = n.nand(b, t1);
  const s1 = n.nand(t2, t3);
  const t4 = n.nand(s1, c);
  const t5 = n.nand(s1, t4);
  const t6 = n.nand(c, t4);
  return [n.nand(t5, t6), n.nand(t4, t1)];
}

/** a + b + cin over max(width) bits. Returns the sum and the carry out. */
export function add(n: Net, a: Word, b: Word, cin: Sig = 0): { sum: Word; carry: Sig } {
  const w = Math.max(a.length, b.length);
  const sum: Word = [];
  let c = cin;
  for (let i = 0; i < w; i++) {
    const [s, co] = fullAdder(n, a[i] ?? 0, b[i] ?? 0, c);
    sum.push(s);
    c = co;
  }
  return { sum, carry: c };
}

/** a - b over a.length bits (two's complement). `borrow` is 1 when b > a. */
export function sub(n: Net, a: Word, b: Word): { diff: Word; borrow: Sig } {
  const nb = resize(b, a.length).map((x) => n.not(x));
  const { sum, carry } = add(n, a, nb, 1);
  return { diff: sum, borrow: n.not(carry) };
}

/** w + 1 when `en`, else w. */
export function incIf(n: Net, w: Word, en: Sig): Word {
  const out: Word = [];
  let c = en;
  for (const x of w) {
    out.push(n.xor(x, c));
    c = n.and(x, c);
  }
  return out;
}

/** w - 1 when `en`, else w. */
export function decIf(n: Net, w: Word, en: Sig): Word {
  const out: Word = [];
  let borrow = en;
  for (const x of w) {
    out.push(n.xor(x, borrow));
    borrow = n.and(n.not(x), borrow);
  }
  return out;
}

/** 1 when w equals the constant k. */
export function eqConst(n: Net, w: Word, k: number): Sig {
  return n.andAll(w.map((x, i) => (Math.floor(k / 2 ** i) % 2 === 1 ? x : n.not(x))));
}

/** 1 when the word is zero. */
export function isZero(n: Net, w: Word): Sig {
  return n.not(n.orAll(w));
}

/** 1 when w >= k, for a constant k. Built from the most significant bit down; constants fold away. */
export function geConst(n: Net, w: Word, k: number): Sig {
  if (k <= 0) return 1;
  if (k >= 2 ** w.length) return 0;
  // ge(i) = w[i..0] >= k[i..0]
  let ge: Sig = 1; // empty suffix: equal, so >=
  for (let i = 0; i < w.length; i++) {
    const kb = Math.floor(k / 2 ** i) % 2;
    // at bit i: if w>k at this bit -> 1; if w<k -> 0; if equal -> lower result
    ge = kb === 1 ? n.and(w[i]!, ge) : n.or(w[i]!, ge);
  }
  return ge;
}

/** s ? x1 : x0, bitwise. */
export function muxWord(n: Net, s: Sig, x1: Word, x0: Word): Word {
  const w = Math.max(x1.length, x0.length);
  return Array.from({ length: w }, (_, i) => n.mux(s, x1[i] ?? 0, x0[i] ?? 0));
}

/** Bitwise AND of a word with one signal. */
export function gate(n: Net, w: Word, en: Sig): Word {
  return w.map((x) => n.and(x, en));
}

/** A register of `width` LATCHes. Set its next value with `n.setDs(reg, next)`. */
export function register(n: Net, width: number): Word {
  return n.latches(width);
}

/** Sum of several words with an adder tree. */
export function sumWords(n: Net, words: Word[]): Word {
  if (words.length === 0) return [0];
  let layer = words.slice();
  while (layer.length > 1) {
    const next: Word[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      if (i + 1 < layer.length) {
        const { sum, carry } = add(n, layer[i]!, layer[i + 1]!);
        next.push([...sum, carry]);
      } else next.push(layer[i]!);
    }
    layer = next;
  }
  return layer[0]!;
}

/** Shift right by a constant amount (logical). */
export function shr(w: Word, k: number): Word {
  return w.map((_, i) => w[i + k] ?? 0);
}

/**
 * A read-only memory: `words[addr]` as `width` bits, addressed by `addr` (LSB first).
 *
 * Each output bit is a multiplexer tree with the most significant address bit at the root. Because `Net` shares
 * identical gates, two aligned blocks with the same contents share one subtree, so the tree is a reduced ordered
 * decision diagram of the data. Addresses past the end of `words` are "don't care": a tree whose one half is all
 * don't-care is replaced by its other half.
 */
export function rom(n: Net, addr: Word, words: ArrayLike<number>, width: number): Word {
  const size = 2 ** addr.length;
  if (words.length > size) throw new Error(`ROM of ${words.length} words needs more than ${addr.length} address bits`);
  const out: Word = [];
  for (let bit = 0; bit < width; bit++) {
    const div = 2 ** bit;
    const memo = new Map<string, Sig>();
    // value of this bit at address i, or -1 for don't care
    const val = (i: number): number => (i < words.length ? Math.floor(words[i]! / div) % 2 : -1);
    const build = (level: number, start: number): Sig | -1 => {
      // level = number of address bits below this node; covers [start, start + 2^level)
      if (level === 0) {
        const v = val(start);
        return v < 0 ? -1 : v;
      }
      if (start >= words.length) return -1;
      const key = `${level}:${start}`;
      const hit = memo.get(key);
      if (hit !== undefined) return hit;
      const half = 2 ** (level - 1);
      const lo = build(level - 1, start);
      const hi = build(level - 1, start + half);
      let r: Sig | -1;
      if (lo === -1) r = hi;
      else if (hi === -1) r = lo;
      else r = n.mux(addr[level - 1]!, hi, lo);
      memo.set(key, r);
      return r;
    };
    const r = build(addr.length, 0);
    out.push(r === -1 ? 0 : r);
  }
  return out;
}
