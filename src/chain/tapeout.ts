/**
 * The write path on X Layer: transistor balances and prices, minting, and the tape-out itself, sent through the
 * visitor's own wallet (EIP-1193). Nothing here holds a key.
 */
import { decodeResult, encodeCall } from "./abi";
import { JsonRpc, RpcError, XLAYER } from "./rpc";

export const WSEL = {
  tapeout: "0x7bd3ac1d",
  TAPEOUT_FEE: "0xadfb2b69",
  transistors: "0x6fbd1719",
  mint: "0x1b2ef1ca",
  mintPrice: "0x6817c76c",
  protocolFee: "0xb0e21e8a",
  balanceOf1155: "0x00fdd58e",
  BEM: "0x65bcc02b",
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
  balanceOf20: "0x70a08231",
} as const;

export const NAND_ID = 0n;
export const LATCH_ID = 1n;
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** The wallet the browser offers: OKX Wallet first, then any injected EIP-1193 provider. */
export function injectedWallet(): Eip1193 | null {
  const w = globalThis as unknown as { okxwallet?: Eip1193; ethereum?: Eip1193 };
  return w.okxwallet ?? w.ethereum ?? null;
}

export async function connectWallet(p: Eip1193): Promise<string> {
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.length) throw new Error("the wallet returned no account");
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: XLAYER.chainIdHex }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: XLAYER.chainIdHex,
          chainName: XLAYER.name,
          nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
          rpcUrls: [XLAYER.rpc],
          blockExplorerUrls: [XLAYER.explorer],
        },
      ],
    });
  }
  return accounts[0]!.toLowerCase();
}

export interface Pricing {
  transistors: string;
  tapeoutFee: bigint;
  mintPrice: bigint;
  protocolFee: bigint;
  /** The ERC-20 the transistors are priced in (BEM), or null when they are priced in OKB. */
  payToken: string | null;
  nand: bigint;
  latch: bigint;
}

async function readUint(rpc: JsonRpc, to: string, data: string): Promise<bigint> {
  return decodeResult(await rpc.call(to, data), ["uint"])[0] as bigint;
}

/** What tape-outs cost on this processor, and the account's transistor balances. */
export async function pricing(rpc: JsonRpc, processor: string, account: string): Promise<Pricing> {
  const transistors = decodeResult(await rpc.call(processor, WSEL.transistors), ["address"])[0] as string;
  const [tapeoutFee, mintPrice, protocolFee] = await Promise.all([
    readUint(rpc, processor, WSEL.TAPEOUT_FEE),
    readUint(rpc, transistors, WSEL.mintPrice),
    readUint(rpc, transistors, WSEL.protocolFee),
  ]);
  let payToken: string | null = null;
  try {
    payToken = decodeResult(await rpc.call(transistors, WSEL.BEM), ["address"])[0] as string;
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
  }
  const bal = (id: bigint) =>
    readUint(rpc, transistors, encodeCall(WSEL.balanceOf1155, [{ type: "address", value: account }, { type: "uint", value: id }]));
  const [nand, latch] = await Promise.all([bal(NAND_ID), bal(LATCH_ID)]);
  return { transistors, tapeoutFee, mintPrice, protocolFee, payToken, nand, latch };
}

/** The cost of minting `amount` transistors of one kind in one call. */
export function mintCost(p: Pricing, amount: bigint): bigint {
  return amount === 0n ? 0n : p.mintPrice * amount + p.protocolFee;
}

export function tapeoutData(netlist: Uint8Array, nIn: number, nOut: number): string {
  return encodeCall(WSEL.tapeout, [
    { type: "bytes", value: netlist },
    { type: "uint", value: nIn },
    { type: "uint", value: nOut },
  ]);
}

export function mintData(id: bigint, amount: bigint): string {
  return encodeCall(WSEL.mint, [{ type: "uint", value: id }, { type: "uint", value: amount }]);
}

export function approveData(spender: string, amount: bigint): string {
  return encodeCall(WSEL.approve, [{ type: "address", value: spender }, { type: "uint", value: amount }]);
}

export async function sendTx(p: Eip1193, from: string, to: string, data: string, value = 0n): Promise<string> {
  const tx: Record<string, string> = { from, to, data };
  if (value > 0n) tx.value = "0x" + value.toString(16);
  return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as string;
}

export interface Receipt {
  status: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
  gasUsed: string;
  blockNumber: string;
}

export async function waitReceipt(rpc: JsonRpc, hash: string, timeoutMs = 180_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Receipt> {
  const start = Date.now();
  for (;;) {
    const r = await rpc.request<Receipt | null>("eth_getTransactionReceipt", [hash]);
    if (r) {
      if (r.status !== "0x1") throw new Error(`transaction ${hash} reverted`);
      return r;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000} s`);
    await sleep(1500);
  }
}

/** The circuit id minted by a tape-out: the ERC-721 Transfer from address zero on the processor. */
export function mintedId(r: Receipt, processor: string, to: string): bigint {
  const zero = "0x" + "0".repeat(64);
  const toTopic = "0x" + to.toLowerCase().slice(2).padStart(64, "0");
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== processor.toLowerCase()) continue;
    if (log.topics[0] === TRANSFER_TOPIC && log.topics[1] === zero && log.topics[2]?.toLowerCase() === toTopic && log.topics.length === 4) {
      return BigInt(log.topics[3]!);
    }
  }
  throw new Error("the receipt holds no circuit mint");
}
