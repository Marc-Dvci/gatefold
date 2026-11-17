/**
 * Gatefold Records from the page: a song's licence terms, the split of one payment along its REF lineage, and the
 * licence itself, paid in USD₮0 with one signed EIP-3009 authorization from the visitor's wallet. Payees withdraw
 * what they are owed. Nothing here holds a key.
 */
import { keccak_256 } from "@noble/hashes/sha3";
import { OP_REF, decode } from "../core/tap02";
import { bytesToHex, decodeResult, encodeCall, hexToBytes } from "./abi";
import { JsonRpc, XLAYER } from "./rpc";
import { type Eip1193, sendTx } from "./tapeout";

/** The terms the deploy script releases with; the contract is the authority once it is on X Layer. */
export const TERMS = {
  /** A song licence: 5 USD₮0 (6 decimals). */
  songPrice: 5_000_000n,
  /** Share of each song licence passed up to the instruments it references, in basis points. */
  songUpstreamBps: 3_000,
  /** Gatefold's fee on each licence, in basis points. */
  feeBps: 250,
} as const;

export const MAX_BPS = 10_000;
export const MAX_PARENTS = 8;
export const MAX_DEPTH = 3;
export const USDT0_DECIMALS = 6;

export const RSEL = {
  releases: "0xf491a84c",
  feeBps: "0x24a9d853",
  parentsOf: "0xf9bb9075",
  owed: "0xdf18e047",
  withdraw: "0x3ccfd60b",
  isLicensed: "0xff44e5d3",
  licenseWithAuthorization: "0xc434e4b6",
  ownerOf: "0x6352211e",
  balanceOf: "0x70a08231",
} as const;

const enc = (types: string[], values: string[]): Uint8Array => {
  // abi.encode of static words only (address, uint256, bytes32): each value padded to 32 bytes.
  const out = new Uint8Array(32 * values.length);
  values.forEach((v, i) => {
    const t = types[i]!;
    const hex = t === "uint" ? BigInt(v).toString(16).padStart(64, "0") : v.slice(2).toLowerCase().padStart(64, "0");
    out.set(hexToBytes("0x" + hex), 32 * i);
  });
  return out;
};

export const keccakHex = (b: Uint8Array): string => bytesToHex(keccak_256(b));

/** The release key Gatefold Records uses: keccak256(abi.encode(processor, id)). */
export function releaseKey(cpu: string, id: bigint): string {
  return keccakHex(enc(["address", "uint"], [cpu, id.toString()]));
}

/** The EIP-3009 nonce that binds a payment to one song and one licensee: keccak256(abi.encode(key, licensee, salt)). */
export function licenceNonce(key: string, licensee: string, salt: string): string {
  return keccakHex(enc(["bytes32", "address", "bytes32"], [key, licensee, salt]));
}

/** The (processor, id) of every REF record of a netlist, in record order, as the contract reads them. */
export function refTargets(netlist: Uint8Array, nIn: number): Array<{ cpu: string; id: bigint }> {
  const out: Array<{ cpu: string; id: bigint }> = [];
  for (const e of decode(netlist, nIn)) if (e.op === OP_REF) out.push({ cpu: e.cpu, id: e.id });
  return out;
}

/** One release in a lineage: who holds it, its upstream share, and the released circuits it references. */
export interface Lineage {
  key: string;
  label: string;
  upstreamBps: number;
  parents: Lineage[];
}

export interface Credit {
  key: string;
  label: string;
  amount: bigint;
}

/**
 * The credits of one licence payment, computed exactly as GatefoldRecords._settle and _split do: the fee first, then
 * the release's upstream share split equally among its parents (each passing on its own share the same way, down to
 * MAX_DEPTH), and the rest to the holder of the circuit. The credits always add up to the price.
 */
export function splitLicence(price: bigint, feeBps: number, release: Lineage, feeLabel = "Gatefold fee"): Credit[] {
  const credits = new Map<string, Credit>();
  const credit = (key: string, label: string, amount: bigint): void => {
    if (amount === 0n) return;
    const c = credits.get(key);
    if (c) c.amount += amount;
    else credits.set(key, { key, label, amount });
  };
  if (price === 0n) return [];
  const fee = (price * BigInt(feeBps)) / BigInt(MAX_BPS);
  credit("fee", feeLabel, fee);
  const split = (r: Lineage, amount: bigint, depth: number): void => {
    const np = BigInt(r.parents.length);
    if (np === 0n || depth >= MAX_DEPTH || r.upstreamBps === 0) {
      credit(r.key, r.label, amount);
      return;
    }
    const each = (amount * BigInt(r.upstreamBps)) / BigInt(MAX_BPS) / np;
    for (const p of r.parents) split(p, each, depth + 1);
    credit(r.key, r.label, amount - each * np);
  };
  split(release, price - fee, 0);
  return [...credits.values()];
}

/** USD₮0 base units as a decimal string: 5000000 -> "5", 292500 -> "0.2925". */
export function usdt0(units: bigint): string {
  const whole = units / 10n ** BigInt(USDT0_DECIMALS);
  const frac = (units % 10n ** BigInt(USDT0_DECIMALS)).toString().padStart(USDT0_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export interface OnChainRelease {
  price: bigint;
  upstreamBps: number;
  exists: boolean;
}

export async function readRelease(rpc: JsonRpc, records: string, key: string): Promise<OnChainRelease> {
  const [, , price, bps, exists] = decodeResult(await rpc.call(records, encodeCall(RSEL.releases, [{ type: "bytes32", value: key }])), [
    "address",
    "uint",
    "uint",
    "uint",
    "bool",
  ]) as [string, bigint, bigint, bigint, boolean];
  return { price, upstreamBps: Number(bps), exists };
}

export async function readFeeBps(rpc: JsonRpc, records: string): Promise<number> {
  return Number(decodeResult(await rpc.call(records, RSEL.feeBps), ["uint"])[0]);
}

/** The parents the contract recorded for a release: a dynamic bytes32[]. */
export async function readParents(rpc: JsonRpc, records: string, key: string): Promise<string[]> {
  const data = hexToBytes(await rpc.call(records, encodeCall(RSEL.parentsOf, [{ type: "bytes32", value: key }])));
  const word = (at: number): bigint => BigInt(bytesToHex(data.slice(at, at + 32)));
  const off = Number(word(0));
  const n = Number(word(off));
  if (n > MAX_PARENTS || off + 32 * (n + 1) > data.length) throw new Error("parentsOf returned malformed data");
  return Array.from({ length: n }, (_, i) => bytesToHex(data.slice(off + 32 * (i + 1), off + 32 * (i + 2))));
}

/**
 * A release's lineage as Gatefold Records holds it: its upstream share, its recorded parents and theirs, down to the
 * contract's depth limit. `label` names a release key for the page.
 */
export async function chainLineage(
  rpc: JsonRpc,
  records: string,
  key: string,
  label: (key: string) => string,
  depth = 0,
): Promise<Lineage> {
  const r = await readRelease(rpc, records, key);
  const parentKeys = depth < MAX_DEPTH && r.upstreamBps > 0 ? await readParents(rpc, records, key) : [];
  const parents = await Promise.all(parentKeys.map((k) => chainLineage(rpc, records, k, label, depth + 1)));
  return { key, label: label(key), upstreamBps: r.upstreamBps, parents };
}

export async function readOwed(rpc: JsonRpc, records: string, account: string): Promise<bigint> {
  return decodeResult(await rpc.call(records, encodeCall(RSEL.owed, [{ type: "address", value: account }])), ["uint"])[0] as bigint;
}

export async function readUsdt0(rpc: JsonRpc, account: string): Promise<bigint> {
  return decodeResult(await rpc.call(XLAYER.usdt0, encodeCall(RSEL.balanceOf, [{ type: "address", value: account }])), [
    "uint",
  ])[0] as bigint;
}

export async function readLicensed(rpc: JsonRpc, records: string, cpu: string, id: bigint, licensee: string): Promise<boolean> {
  const data = encodeCall(RSEL.isLicensed, [
    { type: "address", value: cpu },
    { type: "uint", value: id },
    { type: "address", value: licensee },
  ]);
  return decodeResult(await rpc.call(records, data), ["bool"])[0] as boolean;
}

export async function readOwner(rpc: JsonRpc, cpu: string, id: bigint): Promise<string> {
  return decodeResult(await rpc.call(cpu, encodeCall(RSEL.ownerOf, [{ type: "uint", value: id }])), ["address"])[0] as string;
}

/** The EIP-712 typed data USD₮0 checks for receiveWithAuthorization, as eth_signTypedData_v4 takes it. */
export function authorizationTypedData(a: {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
}): Record<string, unknown> {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ReceiveWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "ReceiveWithAuthorization",
    domain: { name: "USD₮0", version: "1", chainId: XLAYER.chainId, verifyingContract: XLAYER.usdt0 },
    message: {
      from: a.from,
      to: a.to,
      value: a.value.toString(),
      validAfter: a.validAfter.toString(),
      validBefore: a.validBefore.toString(),
      nonce: a.nonce,
    },
  };
}

/** Split a 65-byte signature into (v, r, s), with v as 27 or 28. */
export function splitSignature(sig: string): { v: number; r: string; s: string } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error("the wallet returned a malformed signature");
  let v = parseInt(sig.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { v, r: "0x" + sig.slice(2, 66), s: "0x" + sig.slice(66, 130) };
}

export function licenseWithAuthorizationData(a: {
  key: string;
  licensee: string;
  salt: string;
  from: string;
  validAfter: bigint;
  validBefore: bigint;
  v: number;
  r: string;
  s: string;
}): string {
  return encodeCall(RSEL.licenseWithAuthorization, [
    { type: "bytes32", value: a.key },
    { type: "address", value: a.licensee },
    { type: "bytes32", value: a.salt },
    { type: "address", value: a.from },
    { type: "uint", value: a.validAfter },
    { type: "uint", value: a.validBefore },
    { type: "uint", value: a.v },
    { type: "bytes32", value: a.r },
    { type: "bytes32", value: a.s },
  ]);
}

export function randomSalt(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Buy a licence: the wallet signs one USD₮0 authorization bound to this song and this licensee, then sends it to
 * Gatefold Records, which pulls the price and credits the lineage. Returns the transaction hash.
 */
export async function buyLicence(
  wallet: Eip1193,
  a: { account: string; records: string; cpu: string; id: bigint; licensee: string; price: bigint; now: bigint },
  salt: string = randomSalt(),
): Promise<string> {
  const key = releaseKey(a.cpu, a.id);
  const nonce = licenceNonce(key, a.licensee, salt);
  const validAfter = 0n;
  const validBefore = a.now + 3600n;
  const typed = authorizationTypedData({ from: a.account, to: a.records, value: a.price, validAfter, validBefore, nonce });
  const sig = (await wallet.request({ method: "eth_signTypedData_v4", params: [a.account, JSON.stringify(typed)] })) as string;
  const { v, r, s } = splitSignature(sig);
  const data = licenseWithAuthorizationData({ key, licensee: a.licensee, salt, from: a.account, validAfter, validBefore, v, r, s });
  return sendTx(wallet, a.account, a.records, data);
}

export function withdrawData(): string {
  return RSEL.withdraw;
}
