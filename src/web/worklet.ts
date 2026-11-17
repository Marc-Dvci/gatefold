/**
 * The AudioWorklet that plays a circuit. One beat of the circuit is one sample: at 24,000 beats per second the
 * worklet runs the compiled netlist 24,000 times a second and sends each output word to the speakers.
 */
import { type Engine, FlatEngine, type FlatProgram, JsEngine, canGenerateCode } from "../core/flat";
import { BEAT_RATE, INC_BITS, PRESCALE } from "../core/instruments";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export type WorkletMode = "song" | "voice" | "raw";

export type ToWorklet =
  | { type: "load"; program: FlatProgram; mode: WorkletMode; scaleMax: number; pins: Uint8Array }
  | { type: "pins"; pins: Uint8Array }
  | { type: "play" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "note"; on: boolean; inc?: number; vol?: number; mode?: number };

export type FromWorklet =
  | { type: "engine"; kind: "compiled" | "interpreter"; gates: number }
  | { type: "frame"; beat: number; state: Uint8Array; scope: Float32Array; level: number };

const FRAME_BEATS = 800; // about 30 frames a second at 24,000 beats per second
const SCOPE = 512;

class GatefoldProcessor extends AudioWorkletProcessor {
  private engine: Engine | null = null;
  private mode: WorkletMode = "song";
  private playing = false;
  private pins: Uint8Array = new Uint8Array(0);
  private mid = 1;
  private beat = 0;
  private sinceFrame = 0;
  private x1 = 0;
  private y1 = 0;
  private raw = new Int32Array(256);
  private scope = new Float32Array(SCOPE);
  private scopeAt = 0;
  private peak = 0;
  // Resampling when the context does not run at the beat rate.
  private readonly ratio = BEAT_RATE / sampleRate;
  private frac = 0;
  private prevSample = 0;
  private curSample = 0;
  // Voice mode.
  private voiceIn: Uint8Array = new Uint8Array(25);
  private trigPending = false;

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<ToWorklet>) => this.onMessage(ev.data);
  }

  private onMessage(m: ToWorklet): void {
    switch (m.type) {
      case "load": {
        const compiled = canGenerateCode();
        this.engine = compiled ? new JsEngine(m.program) : new FlatEngine(m.program);
        this.mode = m.mode;
        this.pins = m.pins;
        this.mid = Math.max(1, m.scaleMax / 2);
        this.beat = 0;
        this.x1 = this.y1 = 0;
        let gates = 0;
        for (const k of m.program.kind) if (k === 3 || k === 5) gates++;
        this.port.postMessage({ type: "engine", kind: compiled ? "compiled" : "interpreter", gates } satisfies FromWorklet);
        break;
      }
      case "pins":
        this.pins = m.pins;
        break;
      case "play":
        this.playing = true;
        break;
      case "pause":
        this.playing = false;
        break;
      case "reset":
        if (this.engine) this.engine.state = new Uint8Array(this.engine.nState);
        this.beat = 0;
        break;
      case "note": {
        const v = this.voiceIn;
        if (m.on) {
          for (let i = 0; i < INC_BITS; i++) v[i] = ((m.inc ?? 0) >> i) & 1;
          for (let i = 0; i < 4; i++) v[17 + i] = ((m.vol ?? 12) >> i) & 1;
          for (let i = 0; i < 4; i++) v[21 + i] = ((m.mode ?? 0) >> i) & 1;
          v[15] = 1;
          this.trigPending = true;
        } else {
          v[15] = 0;
        }
        break;
      }
    }
  }

  /** Produce `n` circuit beats into this.raw. */
  private runBeats(n: number): void {
    const e = this.engine!;
    if (this.raw.length < n) this.raw = new Int32Array(n);
    if (this.mode !== "voice") {
      e.run(n, this.pins, this.raw, 0);
      return;
    }
    // Voice mode: the envelope tick is one beat in 2^PRESCALE, and a note-on is a one-beat trigger.
    const v = this.voiceIn;
    let done = 0;
    const period = 1 << PRESCALE;
    while (done < n) {
      const pos = (this.beat + done) % period;
      if (pos === 0 || this.trigPending) {
        v[16] = pos === 0 ? 1 : 0;
        v[14] = this.trigPending ? 1 : 0;
        this.trigPending = false;
        e.run(1, v, this.raw, done);
        v[14] = 0;
        v[16] = 0;
        done += 1;
        continue;
      }
      const span = Math.min(n - done, period - pos);
      e.run(span, v, this.raw, done);
      done += span;
    }
  }

  /** Unipolar circuit word to a centred float: 0 is silence, and a DC blocker removes the average. */
  private toFloat(w: number): number {
    const x = w / this.mid;
    const y = x - this.x1 + 0.9995 * this.y1;
    this.x1 = x;
    this.y1 = y;
    return y * 0.8;
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]![0]!;
    if (!this.engine || !this.playing) {
      out.fill(0);
      return true;
    }
    if (this.ratio === 1) {
      this.runBeats(out.length);
      for (let i = 0; i < out.length; i++) out[i] = this.toFloat(this.raw[i]!);
      this.afterBeats(out, out.length);
    } else {
      // Linear interpolation between beats.
      const need = Math.ceil(out.length * this.ratio) + 2;
      const produced = new Float32Array(need);
      let made = 0;
      for (let i = 0; i < out.length; i++) {
        this.frac += this.ratio;
        while (this.frac >= 1) {
          this.runBeats(1);
          this.prevSample = this.curSample;
          this.curSample = this.toFloat(this.raw[0]!);
          produced[made++] = this.curSample;
          this.frac -= 1;
        }
        out[i] = this.prevSample + (this.curSample - this.prevSample) * this.frac;
      }
      this.afterBeats(produced, made);
    }
    for (let ch = 1; ch < outputs[0]!.length; ch++) outputs[0]![ch]!.set(out);
    return true;
  }

  private afterBeats(samples: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      this.scope[this.scopeAt] = samples[i]!;
      this.scopeAt = (this.scopeAt + 1) % SCOPE;
      const a = Math.abs(samples[i]!);
      if (a > this.peak) this.peak = a;
    }
    this.beat += n;
    this.sinceFrame += n;
    if (this.sinceFrame >= FRAME_BEATS) {
      this.sinceFrame = 0;
      const scope = new Float32Array(SCOPE);
      for (let i = 0; i < SCOPE; i++) scope[i] = this.scope[(this.scopeAt + i) % SCOPE]!;
      const msg: FromWorklet = { type: "frame", beat: this.beat, state: this.engine!.state.slice(), scope, level: this.peak };
      this.peak = 0;
      this.port.postMessage(msg);
    }
  }
}

registerProcessor("gatefold", GatefoldProcessor);
