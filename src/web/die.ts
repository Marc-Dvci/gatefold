/**
 * The die view: a circuit drawn as a chip floorplan, one cell per gate, lit by what the circuit is doing.
 *
 * Every instance (the song itself and each instrument it references) is a block; inside a block, every region
 * (score ROM, pitch table, oscillator, envelope, mixer...) is a sub-block; inside, every NAND is a small cell and every
 * LATCH a larger one. While a song plays, each cell glows when its gate changed since the last frame.
 */
import { FlatEngine, type FlatProgram, K_LATCH, K_NAND, K_NOT } from "../core/flat";

export type RegionOf = (instance: number, elem: number) => string;

interface Frame {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Block {
  region: string;
  color: [number, number, number];
  x: number;
  y: number;
  w: number;
  h: number;
  nodes: number[];
  cols: number;
  cell: number;
}

const PALETTE: Array<[RegExp, [number, number, number]]> = [
  [/score/, [140, 124, 240]],
  [/pitch/, [86, 156, 255]],
  [/control|pins/, [52, 209, 191]],
  [/clock|sequencer/, [242, 193, 78]],
  [/mixer|output/, [240, 98, 146]],
  [/oscillator|accumulator/, [217, 130, 75]],
  [/envelope/, [255, 170, 60]],
  [/waveform|lfsr|intervals/, [120, 220, 120]],
  [/pitch|drop/, [86, 156, 255]],
];

export function regionColor(region: string): [number, number, number] {
  for (const [re, c] of PALETTE) if (re.test(region)) return c;
  return [170, 178, 196];
}

/** Squarified treemap of weights into a rectangle. */
export function squarify(weights: number[], x: number, y: number, w: number, h: number): Array<{ x: number; y: number; w: number; h: number }> {
  const total = weights.reduce((a, b) => a + b, 0);
  const out = new Array<{ x: number; y: number; w: number; h: number }>(weights.length);
  if (total <= 0 || weights.length === 0) return out.fill({ x, y, w: 0, h: 0 });
  const idx = weights.map((_, i) => i).sort((a, b) => weights[b]! - weights[a]!);
  const scale = (w * h) / total;
  let rx = x,
    ry = y,
    rw = w,
    rh = h;
  let i = 0;
  while (i < idx.length) {
    const short = Math.min(rw, rh);
    const row: number[] = [];
    let rowSum = 0;
    let worst = Infinity;
    while (i < idx.length) {
      const a = weights[idx[i]!]! * scale;
      const s = rowSum + a;
      const maxA = Math.max(...row.map((j) => weights[j]! * scale), a);
      const minA = Math.min(...row.map((j) => weights[j]! * scale), a);
      const ratio = Math.max((short * short * maxA) / (s * s), (s * s) / (short * short * minA));
      if (row.length && ratio > worst) break;
      row.push(idx[i]!);
      rowSum = s;
      worst = ratio;
      i++;
    }
    const thick = rowSum / short;
    let off = 0;
    for (const j of row) {
      const len = (weights[j]! * scale) / thick;
      out[j] = rw >= rh ? { x: rx, y: ry + off, w: thick, h: len } : { x: rx + off, y: ry, w: len, h: thick };
      off += len;
    }
    if (rw >= rh) {
      rx += thick;
      rw -= thick;
    } else {
      ry += thick;
      rh -= thick;
    }
  }
  return out;
}

export class DieView {
  private blocks: Block[] = [];
  private frames: Frame[] = [];
  private program: FlatProgram | null = null;
  private engine: FlatEngine | null = null;
  private sig: Uint8Array = new Uint8Array(0);
  private prev: Uint8Array = new Uint8Array(0);
  private heat = new Float32Array(0);
  private dpr = 1;
  private labelFn: (instance: number) => string = () => "";
  private pins: Uint8Array = new Uint8Array(0);

  constructor(private readonly canvas: HTMLCanvasElement) {}

  setProgram(p: FlatProgram, regionOf: RegionOf, instanceLabel: (i: number) => string, pins: Uint8Array): void {
    this.program = p;
    this.engine = new FlatEngine(p);
    this.sig = new Uint8Array(p.kind.length);
    this.prev = new Uint8Array(p.kind.length);
    this.heat = new Float32Array(p.kind.length);
    this.labelFn = instanceLabel;
    this.pins = pins;
    this.layout(regionOf);
    this.engine.probe(pins.length === p.nIn ? pins : new Uint8Array(p.nIn), this.sig);
    this.prev.set(this.sig);
    this.draw();
  }

  setPins(pins: Uint8Array): void {
    this.pins = pins;
  }

  private layout(regionOf: RegionOf): void {
    const p = this.program!;
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const W = Math.max(200, Math.round(rect.width));
    const H = Math.max(200, Math.round(rect.height || rect.width));
    this.canvas.width = W * this.dpr;
    this.canvas.height = H * this.dpr;
    // Group nodes: instance -> region -> nodes.
    const byInst = new Map<number, Map<string, number[]>>();
    for (let i = 2; i < p.kind.length; i++) {
      const k = p.kind[i]!;
      if (k !== K_NAND && k !== K_NOT && k !== K_LATCH) continue;
      const inst = p.owner[i]!;
      const region = regionOf(inst, p.elem[i]!);
      let m = byInst.get(inst);
      if (!m) byInst.set(inst, (m = new Map()));
      let list = m.get(region);
      if (!list) m.set(region, (list = []));
      list.push(i);
    }
    const insts = [...byInst.keys()];
    const pad = 6;
    const instRects = squarify(
      insts.map((i) => [...byInst.get(i)!.values()].reduce((a, l) => a + l.length, 0)),
      pad,
      pad,
      W - 2 * pad,
      H - 2 * pad,
    );
    this.blocks = [];
    this.frames = [];
    insts.forEach((inst, k) => {
      const r = instRects[k]!;
      this.frames.push({ label: this.labelFn(inst), ...r });
      const regions = [...byInst.get(inst)!.entries()];
      const head = r.h > 60 && r.w > 60 ? 14 : 0;
      const sub = squarify(
        regions.map(([, l]) => l.length),
        r.x + 3,
        r.y + 3 + head,
        Math.max(1, r.w - 6),
        Math.max(1, r.h - 6 - head),
      );
      regions.forEach(([region, nodes], j) => {
        const s = sub[j]!;
        const n = nodes.length;
        const iw = Math.max(1, s.w - 2);
        const ih = Math.max(1, s.h - 2);
        let cols = Math.max(1, Math.ceil(Math.sqrt((n * iw) / ih)));
        let cell = Math.min(iw / cols, ih / Math.ceil(n / cols));
        // Try one more column if it gives bigger cells.
        const cols2 = cols + 1;
        const cell2 = Math.min(iw / cols2, ih / Math.ceil(n / cols2));
        if (cell2 > cell) {
          cols = cols2;
          cell = cell2;
        }
        this.blocks.push({
          region,
          color: regionColor(region),
          x: s.x + 1,
          y: s.y + 1,
          w: s.w,
          h: s.h,
          nodes,
          cols,
          cell,
        });
      });
    });
  }

  /** Feed a state snapshot from the player: compute every gate's value and redraw. */
  update(state: Uint8Array): void {
    if (!this.engine || state.length !== this.engine.nState) return;
    this.engine.state = state.slice();
    this.prev.set(this.sig);
    this.engine.probe(this.pins.length === this.engine.nIn ? this.pins : new Uint8Array(this.engine.nIn), this.sig);
    const n = this.sig.length;
    for (let i = 0; i < n; i++) {
      this.heat[i] = this.sig[i] !== this.prev[i] ? 1 : this.heat[i]! * 0.82;
    }
    this.draw();
  }

  /** Let the glow fade when playback stops. */
  cool(): void {
    for (let i = 0; i < this.heat.length; i++) this.heat[i]! *= 0.8;
    this.draw();
  }

  draw(): void {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || !this.program) return;
    const d = this.dpr;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const W = this.canvas.width / d;
    const H = this.canvas.height / d;
    ctx.fillStyle = "#07090d";
    ctx.fillRect(0, 0, W, H);
    // Die edge and bond pads.
    ctx.strokeStyle = "rgba(242,193,78,0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(2.5, 2.5, W - 5, H - 5);
    const kind = this.program.kind;
    for (const f of this.frames) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
    }
    for (const b of this.blocks) {
      const [r, g, bl] = b.color;
      const c = b.cell;
      const gap = c >= 4 ? 1 : c >= 2.5 ? 0.5 : 0;
      for (let k = 0; k < b.nodes.length; k++) {
        const node = b.nodes[k]!;
        const x = b.x + (k % b.cols) * c;
        const y = b.y + Math.floor(k / b.cols) * c;
        const heat = this.heat[node]!;
        const on = this.sig[node]!;
        const lum = 0.16 + 0.22 * on + 0.62 * heat;
        ctx.fillStyle = `rgb(${Math.round(r * lum)},${Math.round(g * lum)},${Math.round(bl * lum)})`;
        if (kind[node] === K_LATCH) {
          ctx.fillRect(x, y, c - gap, c - gap);
          ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.6 * heat})`;
          ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, c - gap - 1), Math.max(0, c - gap - 1));
        } else {
          ctx.fillRect(x, y, c - gap, c - gap);
        }
      }
    }
    ctx.font = "600 11px 'Inter Tight', system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    for (const f of this.frames) if (f.h > 60 && f.w > 60) ctx.fillText(f.label, f.x + 5, f.y + 12, f.w - 10);
  }

  /** The value of a group of nodes as an unsigned word (LSB first), from the last update. */
  word(nodes: number[]): number {
    let v = 0;
    nodes.forEach((n, i) => (v |= (this.sig[n] ?? 0) << i));
    return v;
  }

  /** Bounding blocks, for tests and the legend. */
  get regions(): string[] {
    return [...new Set(this.blocks.map((b) => b.region))];
  }
}
