import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Deployment } from "../src/deployments";
import { CATALOG, songOnChain } from "../src/web/catalog";

// The deployment a fork rehearsal of scripts/deploy.ts wrote: the same keys a live run writes.
const fork = JSON.parse(readFileSync(new URL("../deployments/xlayer-fork.json", import.meta.url), "utf8")) as Deployment;

describe("the catalog and the deployment agree", () => {
  it("every song of the site is a file the deploy script tapes out", () => {
    for (const c of CATALOG) expect(existsSync(new URL(`../songs/${c.file}.json`, import.meta.url)), c.file).toBe(true);
  });

  it("every song page finds its own circuit in a deployment", () => {
    for (const c of CATALOG) {
      expect(songOnChain(c.slug, fork), c.slug).toEqual({ processor: fork.processor, id: BigInt(fork.songs[c.file]!) });
    }
    expect(Object.keys(fork.songs).sort()).toEqual(CATALOG.map((c) => c.file).sort());
  });

  it("before the deployment, no song claims a circuit", () => {
    for (const c of CATALOG) expect(songOnChain(c.slug, null)).toBeNull();
  });
});
