/**
 * Where Gatefold lives on X Layer. `scripts/deploy.ts` writes `deployments/xlayer.json` after a tape-out; until then
 * the app plays the same circuits from the local preview processor.
 */
import data from "@deployment";

export interface Deployment {
  chainId: number;
  processor: string;
  transistors: string;
  records: string | null;
  /** Instrument key to circuit id. */
  instruments: Record<string, string>;
  /** Song slug to circuit id. */
  songs: Record<string, string>;
  block: number;
}

const raw = data as unknown as Partial<Deployment> & { processor: string | null };

export const DEPLOYMENT: Deployment | null = raw.processor ? (raw as Deployment) : null;
