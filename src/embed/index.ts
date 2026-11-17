/**
 * Gatefold embed: play a song circuit inside any page or game, straight from X Layer, and steer it with its pins.
 *
 *   import { GatefoldPlayer } from "./gatefold.js";
 *   const song = await GatefoldPlayer.fromChain("0x…processor", 6n);
 *   await song.play();
 *   song.setIntensity(2);   // a channel plays once the intensity reaches its layer
 *   song.setDrive(true);    // the faster tempo, for a boss fight
 *
 * Copy gatefold.js and its worklet file into your own site: a DeWEB site then plays music from chain bytes and its
 * only request goes to rpc.xlayer.tech.
 */
import { loadFromChain } from "../chain/processor";
import { JsonRpc, XLAYER } from "../chain/rpc";
import { type FlatProgram, flatten, gateCount, simplify } from "../core/flat";
import type { Circuit } from "../core/tap02";
import { Player } from "../web/audio";

export interface SongInfo {
  /** Gates the player runs per beat, after inlining every instrument. */
  gates: number;
  stateBits: number;
  outputBits: number;
}

let counter = 0;

export class GatefoldPlayer {
  private readonly player = new Player();
  private intensity = 3;
  private drive = false;
  private readonly key = `embed:${counter++}`;
  readonly info: SongInfo;

  private constructor(private readonly program: FlatProgram) {
    this.info = { gates: gateCount(program), stateBits: program.nState, outputBits: program.nOut };
  }

  /** A song circuit as the Gatefold compiler builds it: 3 pins in, unsigned PCM out. */
  static fromCircuit(circuit: Circuit): GatefoldPlayer {
    if (circuit.nIn !== 3) throw new Error("a Gatefold song has three input pins (intensity 0-1, drive)");
    if (circuit.nOut > 16) throw new Error("a Gatefold song outputs at most 16 bits of PCM");
    return new GatefoldPlayer(simplify(flatten(circuit)));
  }

  /** Read the song and every instrument it references from X Layer, check it, and get it ready to play. */
  static async fromChain(processor: string, id: bigint, rpcUrl: string = XLAYER.rpc): Promise<GatefoldPlayer> {
    const c = await loadFromChain(new JsonRpc(rpcUrl), processor, id);
    return GatefoldPlayer.fromCircuit(c.circuit);
  }

  private pins(): Uint8Array {
    return new Uint8Array([this.intensity & 1, (this.intensity >> 1) & 1, this.drive ? 1 : 0]);
  }

  async play(): Promise<void> {
    if (this.player.loadedKey !== this.key) await this.player.load(this.key, this.program, "song", 2 ** this.program.nOut - 1, this.pins());
    await this.player.play();
  }

  pause(): void {
    this.player.pause();
  }

  /** Start the song again from its first beat. */
  restart(): void {
    this.player.reset();
  }

  setIntensity(level: number): void {
    this.intensity = Math.max(0, Math.min(3, Math.round(level)));
    this.player.setPins(this.pins());
  }

  setDrive(on: boolean): void {
    this.drive = on;
    this.player.setPins(this.pins());
  }

  get playing(): boolean {
    return this.player.playing;
  }
}
