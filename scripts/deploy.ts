/**
 * Press Gatefold on X Layer: create the Gatefold processor, mint transistors, tape out the instruments and the songs,
 * check every song against the processor's own step(), deploy Gatefold Records, release the circuits and buy one
 * licence in USD₮0 with a signed authorization.
 *
 *   npx tsx scripts/deploy.ts --fork          rehearsal on a local fork of X Layer mainnet (anvil), no funds needed
 *   npx tsx scripts/deploy.ts --live          plan only: prints what the live run would send and cost
 *   npx tsx scripts/deploy.ts --live --yes    sends it, from the key in GATEFOLD_DEPLOYER_KEY
 *
 * The fork run writes deployments/xlayer-fork.json and docs/evidence/fork-rehearsal.json; the live run writes
 * deployments/xlayer.json, which the web app reads.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  parseAbi,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { flatten, simplify, JsEngine } from "../src/core/flat";
import { INSTRUMENTS } from "../src/core/instruments";
import { Library, type Song, compileSong } from "../src/core/song";
import { beat, bytesToHex, pack, unpack } from "../src/core/tap02";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const FORK = args.has("--fork");
const LIVE = args.has("--live");
const SEND = args.has("--yes");
if (FORK === LIVE) {
  console.error("Choose one: --fork (rehearsal on a local fork) or --live (X Layer mainnet).");
  process.exit(2);
}

const XLAYER_RPC = process.env.XLAYER_RPC ?? "https://rpc.xlayer.tech";
const FORK_PORT = 8546;
const FACTORY: Address = "0x1f09DAeFA827f02CBb40967cc91b259763760761";
const USDT0: Address = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";
const USDT0_BALANCE_SLOT = 51n;
// Fresh keys for the fork. anvil's well-known test keys are public, and on X Layer mainnet their addresses carry
// code (an EIP-7702 delegation), which ERC-1155 mints refuse as a receiver.
const FORK_DEPLOYER = generatePrivateKey();
const FORK_BUYER = generatePrivateKey();

const OPENER: Address = "0x536adD8F30f03b69f6fbF29d425A816A0dC50106";
const SITES: Address = "0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6";
const BINDING: Address = "0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9";
const CHUNK = 24_000;
const SITE_HOST_SONG = "gatefold-theme";

const PROCESSOR = { name: "Gatefold", symbol: "GATE", story: "Songs pressed as chips: every instrument and every song is a TapeOut circuit.", supply: 100_000_000n, mintPrice: 100n };
const SONG_PRICE = 5_000_000n; // 5 USD₮0
const SONG_UPSTREAM_BPS = 3_000;
const FEE_BPS = 250;

const factoryAbi = parseAbi([
  "function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address transistors, address circuits)",
  "function deployFee() view returns (uint256)",
  "function bem() view returns (address)",
  "function isCPU(address) view returns (bool)",
]);
const cpuAbi = parseAbi([
  "function tapeout(bytes netlist, uint32 nIn, uint32 nOut) payable returns (uint256 id)",
  "function TAPEOUT_FEE() view returns (uint256)",
  "function transistors() view returns (address)",
  "function netlist(uint256 id) view returns (bytes)",
  "function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)",
  "function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)",
  "function ownerOf(uint256 id) view returns (address)",
  "function nextId() view returns (uint256)",
]);
const transistorAbi = parseAbi([
  "function mint(uint256 id, uint256 amount) payable",
  "function mintPrice() view returns (uint256)",
  "function protocolFee() view returns (uint256)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
const erc20Abi = parseAbi([
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const openerAbi = parseAbi([
  "function FEE() view returns (uint256)",
  "function open(address processor, uint256 id) payable returns (address)",
  "function accountOf(address processor, uint256 id) view returns (address)",
  "function isOpened(address processor, uint256 id) view returns (bool)",
]);
const sitesAbi = parseAbi([
  "function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)",
  "function appendChunk(address container, string path, uint256 expectIndex, bytes data)",
  "function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)",
  "function readRange(address container, string path, uint256 offset, uint256 len) view returns (bytes)",
]);
const bindingAbi = parseAbi([
  "function monthlyFee() view returns (uint256)",
  "function bind(string name, address container, uint256 months) payable",
  "function isLive(string name, address container) view returns (bool)",
]);
const factoryCountAbi = parseAbi(["function cpuCount() view returns (uint256)", "function cpuAt(uint256) view returns (address)"]);
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  woff2: "font/woff2",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
};

function siteFiles(dir: string): Array<{ path: string; data: Buffer; type: string }> {
  const out: Array<{ path: string; data: Buffer; type: string }> = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else {
        const ext = e.name.split(".").pop()!.toLowerCase();
        out.push({ path: r, data: readFileSync(join(dir, r)), type: CONTENT_TYPES[ext] ?? "application/octet-stream" });
      }
    }
  };
  walk("");
  // HTML last, so a visitor never gets a page whose scripts are not written yet.
  return out.sort((a, b) => Number(a.type.startsWith("text/html")) - Number(b.type.startsWith("text/html")) || a.path.localeCompare(b.path));
}

const recordsAbi = parseAbi([
  "function release(address cpu, uint256 id, uint128 price, uint16 upstreamBps, string meta) returns (bytes32)",
  "function keyOf(address cpu, uint256 id) pure returns (bytes32)",
  "function parentsOf(bytes32 key) view returns (bytes32[])",
  "function licenseWithAuthorization(bytes32 key, address licensee, bytes32 salt, address from, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function owed(address) view returns (uint256)",
  "function totalOwed() view returns (uint256)",
  "function isLicensed(address cpu, uint256 id, address licensee) view returns (bool)",
  "function withdraw()",
]);

interface Step {
  what: string;
  tx?: Hex;
  gas?: string;
  ms?: number;
  note?: string;
}
const log: Step[] = [];
const t0 = Date.now();

function say(s: string): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
}

async function startAnvil(): Promise<ChildProcess> {
  const bin = process.env.ANVIL ?? "anvil";
  const child = spawn(bin, ["--fork-url", XLAYER_RPC, "--port", String(FORK_PORT), "--chain-id", "196", "--silent", "--gas-limit", "210000000", "--code-size-limit", "50000"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${FORK_PORT}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
      if (r.ok) return child;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("anvil did not start");
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}

function balanceSlot(holder: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));
}

async function main(): Promise<void> {
  let anvil: ChildProcess | null = null;
  const url = FORK ? `http://127.0.0.1:${FORK_PORT}` : XLAYER_RPC;
  if (FORK) {
    say(`Starting anvil on a fork of X Layer (${XLAYER_RPC})…`);
    anvil = await startAnvil();
  }
  try {
    const chain = defineChain({ id: 196, name: "X Layer", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [url] } } });
    const pub = createPublicClient({ chain, transport: http(url, { timeout: 120_000 }) });
    const key = FORK ? FORK_DEPLOYER : (process.env.GATEFOLD_DEPLOYER_KEY as Hex | undefined);
    if (!key) throw new Error("set GATEFOLD_DEPLOYER_KEY for a live run");
    const account = privateKeyToAccount(key);
    const wallet = createWalletClient({ account, chain, transport: http(url, { timeout: 120_000 }) });
    const forkBlock = await pub.getBlockNumber();
    say(`Block ${forkBlock}, deployer ${account.address}`);

    const send = async (what: string, to: Address, data: Hex, value = 0n): Promise<{ hash: Hex; gas: bigint; logs: Array<{ address: Address; topics: Hex[] }> }> => {
      const t = Date.now();
      const hash = await wallet.sendTransaction({ to, data, value, chain });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success") throw new Error(`${what} reverted (${hash})`);
      log.push({ what, tx: hash, gas: r.gasUsed.toString(), ms: Date.now() - t });
      say(`${what}: gas ${r.gasUsed}`);
      return { hash, gas: r.gasUsed, logs: r.logs as never };
    };
    const { encodeFunctionData, decodeFunctionResult } = await import("viem");

    // Compile everything first, so the plan is exact.
    const songs = readdirSync(join(ROOT, "songs"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ slug: f.replace(/\.json$/, ""), song: JSON.parse(readFileSync(join(ROOT, "songs", f), "utf8")) as Song }));
    const instKeys = Object.keys(INSTRUMENTS);
    const preview = new Library("0x" + "00".repeat(20), Object.fromEntries(instKeys.map((k, i) => [k, BigInt(i + 1)])));
    let needNand = 0n;
    let needLatch = 0n;
    for (const k of instKeys) {
      needNand += BigInt(preview.get(k).build.nand);
      needLatch += BigInt(preview.get(k).build.latch);
    }
    for (const s of songs) {
      const cs = compileSong(s.song, preview);
      needNand += BigInt(cs.build.nand);
      needLatch += BigInt(cs.build.latch);
    }
    say(`Plan: 1 processor, ${instKeys.length} instruments, ${songs.length} songs; ${needNand} NAND and ${needLatch} LATCH transistors to burn.`);

    const bem = (await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "bem" })) as Address;
    const deployFee = (await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "deployFee" })) as bigint;
    say(`createCPU costs ${deployFee} BEM base units (token ${bem}).`);

    if (FORK) {
      // Fund the fork accounts: OKB for gas and fees, BEM for the processor and transistors, USD₮0 for the buyer.
      await rpc(url, "anvil_setBalance", [account.address, toHex(10n ** 20n)]);
      let bemSlot = -1n;
      for (let s = 0n; s < 80n; s++) {
        const slot = balanceSlot(account.address, s);
        const before = await rpc(url, "eth_getStorageAt", [bem, slot, "latest"]);
        await rpc(url, "anvil_setStorageAt", [bem, slot, toHex(10n ** 18n, { size: 32 })]);
        const bal = (await pub.readContract({ address: bem, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (bal === 10n ** 18n) {
          bemSlot = s;
          break;
        }
        await rpc(url, "anvil_setStorageAt", [bem, slot, before]);
      }
      if (bemSlot < 0n) throw new Error("BEM balance slot not found");
      say(`Fork funded: 100 OKB and BEM (balance mapping at slot ${bemSlot}).`);
    } else if (!SEND) {
      say("Plan only. Re-run with --yes to send.");
      return;
    }

    // 1. The Gatefold processor.
    await send("approve BEM for createCPU", bem, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FACTORY, deployFee] }));
    const sim = await pub.simulateContract({ account, address: FACTORY, abi: factoryAbi, functionName: "createCPU", args: [PROCESSOR.name, PROCESSOR.symbol, PROCESSOR.story, PROCESSOR.supply, PROCESSOR.mintPrice] });
    const [transistors, processor] = sim.result as [Address, Address];
    await send("createCPU Gatefold", FACTORY, encodeFunctionData({ abi: factoryAbi, functionName: "createCPU", args: [PROCESSOR.name, PROCESSOR.symbol, PROCESSOR.story, PROCESSOR.supply, PROCESSOR.mintPrice] }));
    const isCpu = await pub.readContract({ address: FACTORY, abi: factoryAbi, functionName: "isCPU", args: [processor] });
    say(`Processor ${processor} (registered: ${isCpu}), transistors ${transistors}`);

    // 2. Transistors.
    const mintPrice = (await pub.readContract({ address: transistors, abi: transistorAbi, functionName: "mintPrice" })) as bigint;
    const protocolFee = (await pub.readContract({ address: transistors, abi: transistorAbi, functionName: "protocolFee" })) as bigint;
    const cost = (n: bigint): bigint => mintPrice * n + protocolFee;
    await send("approve BEM for transistors", bem, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [transistors, cost(needNand) + cost(needLatch)] }));
    await send(`mint ${needNand} NAND`, transistors, encodeFunctionData({ abi: transistorAbi, functionName: "mint", args: [0n, needNand] }));
    await send(`mint ${needLatch} LATCH`, transistors, encodeFunctionData({ abi: transistorAbi, functionName: "mint", args: [1n, needLatch] }));

    // 3. Instruments.
    const fee = (await pub.readContract({ address: processor, abi: cpuAbi, functionName: "TAPEOUT_FEE" })) as bigint;
    const TRANSFER = keccak256(toHex("Transfer(address,address,uint256)"));
    const tapeout = async (what: string, bytes: Uint8Array, nIn: number, nOut: number): Promise<bigint> => {
      const r = await send(what, processor, encodeFunctionData({ abi: cpuAbi, functionName: "tapeout", args: [bytesToHex(bytes) as Hex, nIn, nOut] }), fee);
      // The circuit id is the ERC-721 token minted to us: Transfer(0, us, id) on the processor.
      const mint = r.logs.find((l) => l.address.toLowerCase() === processor.toLowerCase() && l.topics[0] === TRANSFER && l.topics.length === 4 && BigInt(l.topics[1]!) === 0n);
      if (!mint) throw new Error(`${what}: no circuit minted`);
      const id = BigInt(mint.topics[3]!);
      const stored = (await pub.readContract({ address: processor, abi: cpuAbi, functionName: "netlist", args: [id] })) as Hex;
      if (stored.toLowerCase() !== bytesToHex(bytes)) throw new Error(`${what}: stored netlist differs`);
      return id;
    };
    const instIds: Record<string, bigint> = {};
    for (const k of instKeys) {
      const b = preview.get(k).build;
      instIds[k] = await tapeout(`tapeout instrument ${k} (${b.bytes.length} bytes)`, b.bytes, b.nIn, b.nOut);
    }
    const lib = new Library(processor, instIds);

    // 4. Songs, compiled against the instruments just taped out.
    const songIds: Record<string, bigint> = {};
    const checks: Array<Record<string, unknown>> = [];
    for (const s of songs) {
      const cs = compileSong(s.song, lib);
      const id = await tapeout(`tapeout song ${s.slug} (${cs.build.bytes.length} bytes)`, cs.build.bytes, cs.build.nIn, cs.build.nOut);
      songIds[s.slug] = id;
      const info = (await pub.readContract({ address: processor, abi: cpuAbi, functionName: "circuitInfo", args: [id] })) as readonly [number, number, number, number];
      if (info[2] !== cs.circuit.nState || info[3] !== cs.circuit.nGates) throw new Error(`${s.slug}: circuitInfo ${info} differs from the compiler`);
      // Bit-exact check: replay the song locally, past its loop point, and send sampled beats to the chain's step(),
      // each with two different pin settings. The samples include row and envelope boundaries and the loop.
      const engine = new JsEngine(simplify(flatten(cs.circuit)));
      const play = new Uint8Array([1, 1, 0]);
      const pinSets = [play, new Uint8Array([0, 1, 1])];
      let seed = 0x6a7e ^ cs.build.bytes.length;
      const rand = (n: number): number => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
      const points = new Set<number>([0, 1, 2, 255, 256, 257, cs.rowBeats - 1, cs.rowBeats, cs.beats - 1, cs.beats, cs.beats + 1]);
      while (points.size < 36) points.add(rand(cs.beats));
      const sorted = [...points].sort((a, b) => a - b);
      let matched = 0;
      let checked = 0;
      let gasPerStep = 0n;
      let at = 0;
      const sink = new Int32Array(Math.max(1, cs.beats + 2));
      for (const t of sorted) {
        if (t > at) engine.run(t - at, play, sink);
        at = t;
        for (const pins of pinSets) {
          const state = engine.state.slice();
          const local = beat(cs.circuit, state, pins);
          const data = encodeFunctionData({ abi: cpuAbi, functionName: "step", args: [id, bytesToHex(pack(state)) as Hex, bytesToHex(pack(pins)) as Hex] });
          const res = (await pub.call({ to: processor, data, gas: 200_000_000n })).data!;
          const [ns, os] = decodeFunctionResult({ abi: cpuAbi, functionName: "step", data: res }) as [Hex, Hex];
          const sameState = bytesToHex(unpack(Buffer.from(ns.slice(2), "hex"), cs.circuit.nState)) === bytesToHex(local.newState);
          const sameOut = bytesToHex(unpack(Buffer.from(os.slice(2), "hex"), cs.circuit.nOut)) === bytesToHex(local.outputs);
          checked++;
          if (sameState && sameOut) matched++;
          if (!gasPerStep) gasPerStep = await pub.estimateGas({ to: processor, data, account: account.address });
        }
      }
      const sampleAt = { size: checked };
      checks.push({ song: s.slug, id: id.toString(), bytes: cs.build.bytes.length, nand: cs.build.nand, latch: cs.build.latch, refs: cs.build.refs, nState: cs.circuit.nState, gates: cs.circuit.nGates, beatsChecked: sampleAt.size, matched, stepGas: gasPerStep.toString() });
      say(`${s.slug}: ${matched}/${sampleAt.size} sampled beats identical to the chain's step() (one step costs ${gasPerStep} gas)`);
      if (matched !== sampleAt.size) throw new Error(`${s.slug}: chain and player disagree`);
    }

    // 5. Gatefold Records.
    const artifact = JSON.parse(readFileSync(join(ROOT, "contracts/out/GatefoldRecords.sol/GatefoldRecords.json"), "utf8")) as { bytecode: { object: Hex } };
    const ctorArgs = encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint16" }], [USDT0, FACTORY, account.address, FEE_BPS]);
    const deployHash = await wallet.sendTransaction({ data: (artifact.bytecode.object + ctorArgs.slice(2)) as Hex, chain });
    const deployReceipt = await pub.waitForTransactionReceipt({ hash: deployHash });
    const records = deployReceipt.contractAddress!;
    log.push({ what: "deploy GatefoldRecords", tx: deployHash, gas: deployReceipt.gasUsed.toString() });
    say(`GatefoldRecords at ${records}`);
    for (const k of instKeys) {
      await send(`release instrument ${k}`, records, encodeFunctionData({ abi: recordsAbi, functionName: "release", args: [processor, instIds[k]!, 0n, 0, `instrument:${k}`] }));
    }
    for (const s of songs) {
      await send(`release song ${s.slug}`, records, encodeFunctionData({ abi: recordsAbi, functionName: "release", args: [processor, songIds[s.slug]!, SONG_PRICE, SONG_UPSTREAM_BPS, `song:${s.slug}`] }));
    }
    const firstSong = songs[0]!.slug;
    const songKey = (await pub.readContract({ address: records, abi: recordsAbi, functionName: "keyOf", args: [processor, songIds[firstSong]!] })) as Hex;
    const parents = (await pub.readContract({ address: records, abi: recordsAbi, functionName: "parentsOf", args: [songKey] })) as Hex[];
    say(`${firstSong}: ${parents.length} instrument parents recorded from its REF records`);

    let licence: Record<string, unknown> = {};
    if (FORK) {
      // 6. One licence in USD₮0, paid with a signed EIP-3009 authorization.
      const buyer = privateKeyToAccount(FORK_BUYER);
      await rpc(url, "anvil_setBalance", [buyer.address, toHex(10n ** 18n)]);
      await rpc(url, "anvil_setStorageAt", [USDT0, balanceSlot(buyer.address, USDT0_BALANCE_SLOT), toHex(100_000_000n, { size: 32 })]);
      const licensee = "0x00000000000000000000000000000000006a3e01" as Address;
      const salt = keccak256(toHex("gatefold-fork-order-1"));
      const nonce = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [songKey, licensee, salt]));
      const blockTime = (await pub.getBlock()).timestamp;
      const validBefore = blockTime + 3600n;
      const sig = await buyer.signTypedData({
        domain: { name: "USD₮0", version: "1", chainId: 196, verifyingContract: USDT0 },
        types: { ReceiveWithAuthorization: [
          { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
        ] },
        primaryType: "ReceiveWithAuthorization",
        message: { from: buyer.address, to: records, value: SONG_PRICE, validAfter: 0n, validBefore, nonce },
      });
      const r = ("0x" + sig.slice(2, 66)) as Hex;
      const s = ("0x" + sig.slice(66, 130)) as Hex;
      const v = parseInt(sig.slice(130, 132), 16);
      await send("licence song with a USD₮0 authorization", records, encodeFunctionData({ abi: recordsAbi, functionName: "licenseWithAuthorization", args: [songKey, licensee, salt, buyer.address, 0n, validBefore, v, r, s] }));
      const owedDeployer = (await pub.readContract({ address: records, abi: recordsAbi, functionName: "owed", args: [account.address] })) as bigint;
      const total = (await pub.readContract({ address: records, abi: recordsAbi, functionName: "totalOwed" })) as bigint;
      const ok = await pub.readContract({ address: records, abi: recordsAbi, functionName: "isLicensed", args: [processor, songIds[firstSong]!, licensee] });
      const buyerLeft = (await pub.readContract({ address: USDT0, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] })) as bigint;
      say(`Licence recorded: ${ok}; ${total} USD₮0 base units credited (deployer, who owns every circuit here: ${owedDeployer}); buyer left with ${buyerLeft}.`);
      await send("withdraw credits", records, encodeFunctionData({ abi: recordsAbi, functionName: "withdraw" }));
      licence = { song: firstSong, price: SONG_PRICE.toString(), licensed: ok, credited: total.toString(), buyerBalanceAfter: buyerLeft.toString(), parents: parents.length };
    }

    // 7. The site itself on chain: build it against this deployment, open the container of the theme song's circuit
    // and write every file into it through the DeWEB site store, then read each one back.
    const deployment = {
      chainId: 196,
      processor,
      transistors,
      records,
      instruments: Object.fromEntries(Object.entries(instIds).map(([k, v]) => [k, v.toString()])),
      songs: Object.fromEntries(Object.entries(songIds).map(([k, v]) => [k, v.toString()])),
      block: Number(await pub.getBlockNumber()),
    };
    const depFile = join(ROOT, FORK ? "deployments/xlayer-fork.json" : "deployments/xlayer.json");
    writeFileSync(depFile, JSON.stringify(deployment, null, 2) + "\n");
    const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, shell: true, stdio: "ignore", env: { ...process.env, GATEFOLD_DEPLOYMENT_FILE: depFile } });
    if (build.status !== 0) throw new Error("the site build failed");
    const files = siteFiles(join(ROOT, "dist"));
    const hostId = songIds[SITE_HOST_SONG]!;
    const container = (await pub.readContract({ address: OPENER, abi: openerAbi, functionName: "accountOf", args: [processor, hostId] })) as Address;
    if (!(await pub.readContract({ address: OPENER, abi: openerAbi, functionName: "isOpened", args: [processor, hostId] }))) {
      const openFee = (await pub.readContract({ address: OPENER, abi: openerAbi, functionName: "FEE" })) as bigint;
      await send(`open the container of circuit #${hostId} (${formatEther(openFee)} OKB)`, OPENER, encodeFunctionData({ abi: openerAbi, functionName: "open", args: [processor, hostId] }), openFee);
    }
    let siteBytes = 0;
    for (const f of files) {
      const hash = ("0x" + createHash("sha256").update(f.data).digest("hex")) as Hex;
      const chunks = Math.max(1, Math.ceil(f.data.length / CHUNK));
      for (let c = 0; c < chunks; c++) {
        const part = bytesToHex(f.data.subarray(c * CHUNK, (c + 1) * CHUNK)) as Hex;
        const data =
          c === 0
            ? encodeFunctionData({ abi: sitesAbi, functionName: "putFile", args: [container, f.path, f.type, hash, part] })
            : encodeFunctionData({ abi: sitesAbi, functionName: "appendChunk", args: [container, f.path, BigInt(c), part] });
        await send(`site ${f.path} chunk ${c + 1}/${chunks}`, SITES, data);
      }
      const info = (await pub.readContract({ address: SITES, abi: sitesAbi, functionName: "fileInfo", args: [container, f.path] })) as readonly [number, string, Hex, number, bigint];
      let back = "0x";
      for (let off = 0; off < f.data.length; off += 64_000) {
        const seg = (await pub.readContract({ address: SITES, abi: sitesAbi, functionName: "readRange", args: [container, f.path, BigInt(off), 64_000n] })) as Hex;
        back += seg.slice(2);
      }
      if (info[0] !== f.data.length || info[2] !== hash || back.toLowerCase() !== bytesToHex(f.data)) throw new Error(`site ${f.path}: read-back differs`);
      siteBytes += f.data.length;
    }
    const cpuCount = (await pub.readContract({ address: FACTORY, abi: factoryCountAbi, functionName: "cpuCount" })) as bigint;
    let procNumber = -1n;
    for (let i = cpuCount - 1n; i >= 0n && i >= cpuCount - 50n; i--) {
      const at = (await pub.readContract({ address: FACTORY, abi: factoryCountAbi, functionName: "cpuAt", args: [i] })) as Address;
      if (at.toLowerCase() === processor.toLowerCase()) {
        procNumber = i;
        break;
      }
    }
    const siteName = `${hostId}.2.${procNumber}.tape`;
    const monthly = (await pub.readContract({ address: BINDING, abi: bindingAbi, functionName: "monthlyFee" })) as bigint;
    await send(`activate ${siteName} for 1 month (${formatEther(monthly)} OKB)`, BINDING, encodeFunctionData({ abi: bindingAbi, functionName: "bind", args: [siteName, container, 1n] }), monthly);
    const live = await pub.readContract({ address: BINDING, abi: bindingAbi, functionName: "isLive", args: [siteName, container] });
    const site = { name: siteName, gateway: `https://${hostId}-2-${procNumber}.tapekit.org/`, container, files: files.length, bytes: siteBytes, live };
    say(`Site: ${files.length} files, ${siteBytes} bytes, written and read back from ${container}; ${siteName} live: ${live}`);

    const out = { ...deployment, site };
    const gasTotal = log.reduce((a, s) => a + BigInt(s.gas ?? "0"), 0n);
    const gasPrice = FORK ? BigInt((await rpc(XLAYER_RPC, "eth_gasPrice", [])) as string) : await pub.getGasPrice();
    if (FORK) {
      writeFileSync(join(ROOT, "deployments/xlayer-fork.json"), JSON.stringify(out, null, 2) + "\n");
      mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
      writeFileSync(
        join(ROOT, "docs/evidence/fork-rehearsal.json"),
        JSON.stringify(
          {
            what: "Gatefold deployment rehearsed on a local anvil fork of X Layer mainnet: real factory, processor, transistor and USD₮0 contracts at the fork block.",
            forkBlock: Number(forkBlock),
            date: new Date().toISOString().slice(0, 10),
            deployment: out,
            songs: checks,
            licence,
            site,
            transactions: log,
            totalGas: gasTotal.toString(),
            xlayerGasPriceWei: gasPrice.toString(),
            okbForGasAtThatPrice: formatEther(gasTotal * gasPrice),
            tapeoutFeesOkb: formatEther(fee * BigInt(instKeys.length + songs.length)),
            seconds: Math.round((Date.now() - t0) / 1000),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      writeFileSync(join(ROOT, "deployments/xlayer.json"), JSON.stringify(out, null, 2) + "\n");
    }
    say(`Done. ${log.length} transactions, ${gasTotal} gas.`);
  } finally {
    anvil?.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
