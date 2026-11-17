/**
 * A small JSON-RPC client for X Layer. On a DeWEB gateway, requests to exactly https://rpc.xlayer.tech/ count as the
 * site's own node, so a Gatefold page that only talks to it keeps its "100% on-chain" status.
 */
import { revertReason } from "./abi";

export const XLAYER = {
  chainId: 196,
  chainIdHex: "0xc4",
  name: "X Layer",
  rpc: "https://rpc.xlayer.tech/",
  explorer: "https://www.oklink.com/xlayer",
  nativeSymbol: "OKB",
  /** The TapeOut processor factory on X Layer (TAP-10 deployments). */
  factory: "0x1f09daefa827f02cbb40967cc91b259763760761",
  /** USD₮0 on X Layer (6 decimals, EIP-2612 and EIP-3009). */
  usdt0: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
} as const;

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: string,
  ) {
    super(message);
    this.name = "RpcError";
  }

  /** The Solidity revert reason, when the error carries one. */
  get reason(): string | undefined {
    return revertReason(this.data) ?? (/execution reverted: (.*)/.exec(this.message)?.[1] || undefined);
  }
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface RpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class JsonRpc {
  private nextId = 1;

  constructor(
    readonly url: string = XLAYER.rpc,
    private readonly fetchFn: Fetch = (u, i) => fetch(u, i),
    private readonly timeoutMs = 20_000,
  ) {}

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.nextId++;
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : undefined;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : undefined;
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: ctrl?.signal,
      });
    } catch (e) {
      throw new RpcError(`network error calling ${method}: ${(e as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new RpcError(`HTTP ${res.status} from the node`, res.status);
    const body = (await res.json()) as RpcResponse;
    if (body.error) {
      const data = typeof body.error.data === "string" ? body.error.data : undefined;
      throw new RpcError(body.error.message, body.error.code, data);
    }
    return body.result as T;
  }

  /** eth_call at a block tag ("latest" by default). */
  call(to: string, data: string, block: string = "latest", gas?: bigint): Promise<string> {
    const tx: Record<string, string> = { to, data };
    if (gas !== undefined) tx.gas = "0x" + gas.toString(16);
    return this.request<string>("eth_call", [tx, block]);
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.request<string>("eth_blockNumber", []));
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.request<string>("eth_chainId", [])));
  }
}
