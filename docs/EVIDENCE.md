# Evidence

Each section gives what was run, the command that reproduces it, and the file that holds the raw result.

## 1. The full release on a fork of X Layer mainnet

`npx tsx scripts/deploy.ts --fork` starts `anvil` on a fork of X Layer mainnet (chain 196) at the latest block, so the
real TapeOut factory, processor and transistor implementations, the DeWEB site store, the name binding and USD₮0 are
the contracts that run. It funds two fresh accounts on the fork, then runs the same steps as the live deployment:

1. `createCPU` on the TapeOut factory: the Gatefold processor and its transistor contract.
2. Mint the NAND and LATCH transistors the release burns (4,788 NAND and 237 LATCH).
3. Tape out the 5 instruments, then compile the 3 songs against the instrument ids just minted and tape them out. Each
   stored netlist is read back and compared with the compiled bytes, and each song's `circuitInfo` with the compiler's
   state and gate counts.
4. Check each song against the processor's own `step()`: the song is replayed locally past its loop point, and at 36
   points (the first beats, row and envelope boundaries, the loop, and seeded random beats) the local state is sent to
   `step()` with two pin settings. The chain's next state and sample must equal the local ones.
5. Deploy Gatefold Records, release the 5 instruments and the 3 songs, and read the theme's parents from its REF
   records.
6. Buy one licence of the theme in USD₮0 with a signed EIP-3009 authorization on the real USD₮0 contract, and withdraw
   the credits.
7. Build the site against this deployment, open the DeWEB container of the theme's circuit, write every file through
   the site store in 24,000-byte chunks, read each one back, and activate the name.

Result, in [`docs/evidence/fork-rehearsal.json`](evidence/fork-rehearsal.json) (fork block 76,109,659):

| Step | Result |
|---|---|
| Transactions | 41, for 73,886,434 gas |
| Songs against `step()` | 72 of 72 beats identical for each of the 3 songs (216 of 216) |
| One `step()` of a song | 7,985,216 to 8,957,478 gas, the cost of the chain recomputing one sample with every instrument |
| Licence | 5 USD₮0 paid with one signature; 5 parents recorded for the theme; 5,000,000 base units credited and withdrawn |
| Site | 12 files, 210,384 bytes, identical on read-back; `6.2.425.tape` live on the fork |

What the live run costs, from the same run at X Layer's gas price of 0.02 gwei: 0.0015 OKB of gas, 0.0104 OKB of
tape-out fees (8 × 0.0013 OKB), 0.08 OKB to open the site's container, the name activation at its monthly fee (0 OKB at
the fork block), and in BEM: 0.1 BEM for `createCPU` plus the transistors at the price the script sets.

## 2. Gatefold's evaluators against X Layer mainnet

`npx tsx scripts/conformance.ts` reads, at one pinned block, every circuit in
[`tests/fixtures/xlayer-sample.json`](../tests/fixtures/xlayer-sample.json): 80 circuits drawn with a fixed seed from
the census of all 11,573 circuits on X Layer (40 with state, 40 without, at most 3 per processor, 48 processors). For
each one it reads the netlist and its REF closure, checks them against `circuitInfo`, then compares 4 beats from random
states and inputs with the processor's `step()` (or `eval()` for a circuit without state).

Result, in [`docs/evidence/xlayer-conformance.json`](evidence/xlayer-conformance.json): 320 of 320 beats identical for
the reference evaluator, and 320 of 320 for the compiled engines (the typed-array interpreter and the generated
JavaScript), at block 76,109,765. The [live workflow](../.github/workflows/live.yml) repeats the run every day.

## 3. The official TAP-02 reference implementation

`python scripts/crosscheck_reference.py` loads each song netlist from [`examples/songs/`](../examples/songs/) into the
reference implementation published with TAP-02 ([`third_party/tap-02/reference.py`](../third_party/tap-02/reference.py)),
resolves its REF records to the instrument netlists in [`examples/instruments/`](../examples/instruments/), and runs the
first 24,000 beats (one second). Every output word must equal the one Gatefold exported. Result: 24,000 of 24,000
samples identical for each of the 3 songs. The reference implementation shares no code with Gatefold.

## 4. The census of X Layer

A read-only scan called `circuitInfo` for every circuit id of every processor the factory lists, at block 76,107,571:
425 processors, 11,573 circuits, 3,004 with state; the median circuit has 26 gates and the largest 174,984. The census
and the seeded sample are in [`tests/fixtures/xlayer-sample.json`](../tests/fixtures/xlayer-sample.json).

## 5. Tests

| Suite | Count | What it holds |
|---|---|---|
| [`tests/tap02.test.ts`](../tests/tap02.test.ts) | 34 | Every published TAP-02 vector (valid, ill-formed, packing), the on-chain popcount circuit on all 256 inputs, encode and decode round trips |
| [`tests/flat.test.ts`](../tests/flat.test.ts) | 9 | Both compiled engines against the reference evaluator on random circuits with LATCH and REF, from random states; the TAP-02 state layout of REF instances |
| [`tests/net.test.ts`](../tests/net.test.ts) | 18 | Folding, sharing and output placement; random boolean expressions; adders, counters and comparators checked exhaustively; the ROM and its sharing |
| [`tests/music.test.ts`](../tests/music.test.ts) | 75 | MML, each instrument's pitch, duty cycle, envelope and noise, each song against the reference evaluator, pins, loop, release, compiler errors, WAV output |
| [`tests/chain.test.ts`](../tests/chain.test.ts) | 26 | ABI encoding held to viem, every selector, the client on answers recorded from X Layer, failure paths, load limits, the wallet path |
| [`e2e/app.spec.ts`](../e2e/app.spec.ts) | 9 | Every page in Chromium, with axe-core and a phone-width check |
| [`contracts/test/GatefoldRecords.t.sol`](../contracts/test/GatefoldRecords.t.sol) | 27 | Releases, parents, splits, remixes, rights following the NFT, EIP-3009 licences, refusals; 2 fuzz tests at 1,024 runs |
