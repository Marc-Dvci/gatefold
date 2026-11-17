/**
 * The main-thread side of playback: one AudioContext, one worklet node, and the frames it sends back.
 */
import type { FlatProgram } from "../core/flat";
import { BEAT_RATE } from "../core/instruments";
import workletUrl from "./worklet.ts?worker&url";
import type { FromWorklet, ToWorklet, WorkletMode } from "./worklet";

export type FrameListener = (f: Extract<FromWorklet, { type: "frame" }>) => void;

export class Player {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private frameListeners = new Set<FrameListener>();
  private stateListeners = new Set<() => void>();
  playing = false;
  engineKind = "";
  /** What is loaded: a key the views use to know whether their circuit is the one playing. */
  loadedKey = "";
  sampleRate = 0;

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: BEAT_RATE, latencyHint: "interactive" });
      } catch {
        ctx = new AudioContext({ latencyHint: "interactive" });
      }
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, "gatefold", { numberOfInputs: 0, outputChannelCount: [2] });
      node.connect(ctx.destination);
      node.port.onmessage = (ev: MessageEvent<FromWorklet>) => {
        const m = ev.data;
        if (m.type === "frame") for (const l of this.frameListeners) l(m);
        else if (m.type === "engine") {
          this.engineKind = m.kind;
          this.emit();
        }
      };
      this.ctx = ctx;
      this.node = node;
      this.sampleRate = ctx.sampleRate;
    })();
    return this.ready;
  }

  private send(m: ToWorklet): void {
    this.node?.port.postMessage(m);
  }

  async load(key: string, program: FlatProgram, mode: WorkletMode, scaleMax: number, pins: Uint8Array): Promise<void> {
    await this.ensure();
    this.send({ type: "load", program, mode, scaleMax, pins });
    this.loadedKey = key;
    this.emit();
  }

  async play(): Promise<void> {
    await this.ensure();
    await this.ctx!.resume();
    this.send({ type: "play" });
    this.playing = true;
    this.emit();
  }

  pause(): void {
    this.send({ type: "pause" });
    this.playing = false;
    this.emit();
  }

  reset(): void {
    this.send({ type: "reset" });
  }

  setPins(pins: Uint8Array): void {
    this.send({ type: "pins", pins });
  }

  noteOn(inc: number, vol: number, mode: number): void {
    this.send({ type: "note", on: true, inc, vol, mode });
  }

  noteOff(): void {
    this.send({ type: "note", on: false });
  }

  onFrame(l: FrameListener): () => void {
    this.frameListeners.add(l);
    return () => this.frameListeners.delete(l);
  }

  onChange(l: () => void): () => void {
    this.stateListeners.add(l);
    return () => this.stateListeners.delete(l);
  }

  private emit(): void {
    for (const l of this.stateListeners) l();
  }
}

export const player = new Player();
