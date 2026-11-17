import { readFileSync } from "node:fs";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { decodeResult, encodeCall, revertReason } from "../src/chain/abi";
import { LIMITS, Processor, SEL, loadFromChain } from "../src/chain/processor";
import { type Fetch, JsonRpc, RpcError, XLAYER } from "../src/chain/rpc";
import {
  type Eip1193,
  type Receipt,
  TRANSFER_TOPIC,
  WSEL,
  approveData,
  connectWallet,
  mintCost,
  mintData,
  mintedId,
  pricing,
  tapeoutData,
  waitReceipt,
} from "../src/chain/tapeout";
import { IllFormed, beat, bytesToHex } from "../src/core/tap02";

const abi = parseAbi([
  "function netlist(uint256 id) view returns (bytes)",
  "function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)",
  "function tapeout(bytes netlist, uint32 nIn, uint32 nOut) payable returns (uint256)",
  "function mint(uint256 id, uint256 amount) payable",
  "function approve(address spender, uint256 value) returns (bool)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function circuitInfo(uint256 id) view returns (uint32, uint32, uint32, uint32)",
]);

const recording = JSON.parse(readFileSync(new URL("./fixtures/xlayer-rpc-recording.json", import.meta.url), "utf8")) as {
  block: string;
  state: number[];
  inputs: number[];
  calls: Array<{ request: { method: string; params: unknown[] }; response: unknown }>;
};

/** Replays recorded X Layer answers: the same request gets the answer the chain gave. */
function replay(): Fetch {
  return async (_url, init) => {
    const req = JSON.parse(init.body) as { method: string; params: unknown[]; id: number };
    const hit = recording.calls.find(
      (c) => c.request.method === req.method && JSON.stringify(c.request.params) === JSON.stringify(req.params),
    );
    if (!hit) throw new Error(`no recorded answer for ${req.method} ${JSON.stringify(req.params).slice(0, 80)}`);
    return { ok: true, status: 200, json: async () => ({ ...(hit.response as object), id: req.id }) };
  };
}

describe("ABI encoding, held to viem", () => {
  it.each([
    ["netlist", [5n]],
    ["step", [7n, "0x01ff", "0x"]],
    ["tapeout", ["0x" + "00".repeat(70), 25, 4]],
    ["mint", [0n, 4788n]],
    ["approve", ["0x" + "ab".repeat(20), 10n ** 30n]],
    ["balanceOf", ["0x" + "cd".repeat(20), 1n]],
  ] as const)("%s", (name, args) => {
    const fn = abi.find((f) => f.name === name)!;
    const ours = encodeCall(
      encodeFunctionData({ abi, functionName: name, args: args as never }).slice(0, 10),
      fn.inputs.map((inp, i) => {
        const v = args[i] as unknown;
        if (inp.type === "bytes") return { type: "bytes", value: Uint8Array.from(Buffer.from((v as string).slice(2), "hex")) };
        if (inp.type === "address") return { type: "address", value: v as string };
        return { type: "uint", value: v as bigint };
      }),
    );
    expect(ours).toBe(encodeFunctionData({ abi, functionName: name, args: args as never }));
  });

  it("decodes (bytes, bytes) and uint tuples as viem does", () => {
    const enc = encodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], ["0x0102030405", `0x${"ff".repeat(40)}`]);
    const [a, b] = decodeResult(enc, ["bytes", "bytes"]) as Uint8Array[];
    const ref = decodeAbiParameters([{ type: "bytes" }, { type: "bytes" }], enc);
    expect(bytesToHex(a!)).toBe(ref[0]);
    expect(bytesToHex(b!)).toBe(ref[1]);
    const tup = encodeAbiParameters(
      [{ type: "uint32" }, { type: "address" }, { type: "bool" }],
      [25, "0x00000000000000000000000000000000ca55e77e", true],
    );
    expect(decodeResult(tup, ["uint", "address", "bool"])).toEqual([25n, "0x00000000000000000000000000000000ca55e77e", true]);
  });

  it("tape-out, mint and approve calldata match viem", () => {
    const nl = Uint8Array.from([0, 0, 0, 2, 0, 0, 3]);
    const hex = bytesToHex(nl) as `0x${string}`;
    expect(tapeoutData(nl, 2, 1)).toBe(encodeFunctionData({ abi, functionName: "tapeout", args: [hex, 2, 1] }));
    expect(mintData(1n, 9n)).toBe(encodeFunctionData({ abi, functionName: "mint", args: [1n, 9n] }));
    expect(approveData("0x" + "11".repeat(20), 5n)).toBe(
      encodeFunctionData({ abi, functionName: "approve", args: [("0x" + "11".repeat(20)) as `0x${string}`, 5n] }),
    );
  });

  it("every selector is the keccak of its signature", () => {
    const sigs: Record<string, string> = {
      [SEL.nextId]: "nextId()",
      [SEL.circuitInfo]: "circuitInfo(uint256)",
      [SEL.netlist]: "netlist(uint256)",
      [SEL.eval]: "eval(uint256,bytes)",
      [SEL.step]: "step(uint256,bytes,bytes)",
      [SEL.tapeout]: "tapeout(bytes,uint32,uint32)",
      [SEL.ownerOf]: "ownerOf(uint256)",
      [SEL.cpuCount]: "cpuCount()",
      [SEL.cpuAt]: "cpuAt(uint256)",
      [WSEL.mint]: "mint(uint256,uint256)",
      [WSEL.mintPrice]: "mintPrice()",
      [WSEL.protocolFee]: "protocolFee()",
      [WSEL.balanceOf1155]: "balanceOf(address,uint256)",
      [WSEL.TAPEOUT_FEE]: "TAPEOUT_FEE()",
      [WSEL.transistors]: "transistors()",
      [WSEL.BEM]: "BEM()",
      [WSEL.approve]: "approve(address,uint256)",
    };
    for (const [sel, sig] of Object.entries(sigs)) expect(keccak256(toHex(sig)).slice(0, 10)).toBe(sel);
    expect(keccak256(toHex("Transfer(address,address,uint256)"))).toBe(TRANSFER_TOPIC);
  });

  it("refuses malformed values instead of encoding garbage", () => {
    expect(() => encodeCall("0x123", [])).toThrow("4 bytes");
    expect(() => encodeCall("0x12345678", [{ type: "address", value: "0x12" }])).toThrow("invalid address");
    expect(() => encodeCall("0x12345678", [{ type: "uint", value: -1n }])).toThrow("uint256");
    expect(() => encodeCall("0x12345678", [{ type: "bytes32", value: "0x00" }])).toThrow("bytes32");
    expect(() => decodeResult("0x00", ["uint"])).toThrow("too short");
  });

  it("reads a Solidity revert reason", () => {
    const data = "0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["no circuit"]).slice(2);
    expect(revertReason(data)).toBe("no circuit");
    expect(revertReason("0xdeadbeef")).toBeUndefined();
    expect(revertReason(undefined)).toBeUndefined();
  });
});

describe("the X Layer client, on answers recorded from X Layer mainnet", () => {
  it("loads a stateful circuit, checks it against circuitInfo, and our beat equals the recorded step()", async () => {
    const rpc = new JsonRpc(XLAYER.rpc, replay());
    const c = await loadFromChain(rpc, "0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6", 3670n, recording.block);
    expect(c.circuit.nState).toBe(51);
    const p = new Processor(rpc, c.cpu, recording.block);
    const state = Uint8Array.from(recording.state);
    const inputs = Uint8Array.from(recording.inputs);
    const chain = await p.step(c.id, c.circuit.nState, c.circuit.nOut, state, inputs);
    const local = beat(c.circuit, state, inputs);
    expect(bytesToHex(chain.newState)).toBe(bytesToHex(local.newState));
    expect(bytesToHex(chain.outputs)).toBe(bytesToHex(local.outputs));
  });

  it("reads the owner and the next id", async () => {
    const rpc = new JsonRpc(XLAYER.rpc, replay());
    const p = new Processor(rpc, "0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6", recording.block);
    expect(await p.ownerOf(3670n)).toMatch(/^0x[0-9a-f]{40}$/);
    expect(await p.nextId()).toBeGreaterThan(3670n);
  });

  it("surfaces the chain's revert reason for a circuit that does not exist", async () => {
    const rpc = new JsonRpc(XLAYER.rpc, replay());
    const p = new Processor(rpc, "0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6", recording.block);
    const err = await p.info(999999n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).reason).toBe("no circuit");
  });
});

describe("JSON-RPC failure paths", () => {
  const answer =
    (body: unknown, ok = true, status = 200): Fetch =>
    async () => ({ ok, status, json: async () => body });

  it("reports an HTTP error", async () => {
    await expect(new JsonRpc("x", answer({}, false, 503)).blockNumber()).rejects.toThrow("HTTP 503");
  });

  it("reports a network failure", async () => {
    const down: Fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(new JsonRpc("x", down).blockNumber()).rejects.toThrow("network error calling eth_blockNumber: ECONNREFUSED");
  });

  it("gives up after its timeout", async () => {
    const hang: Fetch = (_u, init) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    await expect(new JsonRpc("x", hang, 20).chainId()).rejects.toThrow("aborted");
  });

  it("passes gas for heavy calls and reads chain ids", async () => {
    let sent = "";
    const spy: Fetch = async (_u, init) => {
      sent = init.body;
      return { ok: true, status: 200, json: async () => ({ result: "0xc4" }) };
    };
    const rpc = new JsonRpc("x", spy);
    expect(await rpc.chainId()).toBe(196);
    await rpc.call("0x" + "00".repeat(20), "0x", "latest", 50_000_000n);
    expect(JSON.parse(sent).params[0].gas).toBe("0x2faf080");
  });
});

describe("chain loading refuses what it cannot evaluate safely (TAP-02 §7)", () => {
  /** A one-circuit chain answering circuitInfo and netlist. */
  function chainOf(info: [number, number, number, number], netlistHex: string): Fetch {
    return async (_u, init) => {
      const req = JSON.parse(init.body) as { params: [{ data: string }]; id: number };
      const sel = req.params[0].data.slice(0, 10);
      const result =
        sel === SEL.circuitInfo
          ? encodeAbiParameters([{ type: "uint32" }, { type: "uint32" }, { type: "uint32" }, { type: "uint32" }], info)
          : encodeAbiParameters([{ type: "bytes" }], [netlistHex as `0x${string}`]);
      return { ok: true, status: 200, json: async () => ({ id: req.id, result }) };
    };
  }

  it("a circuit above the gate limit", async () => {
    const rpc = new JsonRpc("x", chainOf([2, 1, 0, LIMITS.maxGates + 1], "0x00000002000003"));
    await expect(loadFromChain(rpc, "0x" + "11".repeat(20), 1n)).rejects.toThrow(IllFormed);
  });

  it("a netlist that disagrees with the chain's own circuitInfo", async () => {
    const rpc = new JsonRpc("x", chainOf([2, 1, 0, 5], "0x00000002000003"));
    await expect(loadFromChain(rpc, "0x" + "11".repeat(20), 1n)).rejects.toThrow("chain reports");
  });

  it("a REF chain deeper than the limit", async () => {
    // Circuit id n references id n + 1 on the same processor, forever.
    const cpu = "11".repeat(20);
    const deep: Fetch = async (_u, init) => {
      const req = JSON.parse(init.body) as { params: [{ data: string }]; id: number };
      const data = req.params[0].data;
      const id = BigInt("0x" + data.slice(10, 74));
      const ref = "02" + cpu + (id + 1n).toString(16).padStart(16, "0") + "0101" + "000002";
      const result = data.startsWith(SEL.circuitInfo)
        ? encodeAbiParameters([{ type: "uint32" }, { type: "uint32" }, { type: "uint32" }, { type: "uint32" }], [1, 1, 0, 1])
        : encodeAbiParameters([{ type: "bytes" }], [("0x" + ref) as `0x${string}`]);
      return { ok: true, status: 200, json: async () => ({ id: req.id, result }) };
    };
    await expect(loadFromChain(new JsonRpc("x", deep), "0x" + cpu, 1n)).rejects.toThrow("REF nesting deeper");
  });
});

describe("the tape-out path through a wallet", () => {
  it("finds the circuit id in a tape-out receipt", () => {
    const me = "0x" + "aa".repeat(20);
    const cpu = "0x" + "bb".repeat(20);
    const r: Receipt = {
      status: "0x1",
      gasUsed: "0x1",
      blockNumber: "0x1",
      logs: [
        {
          address: "0x" + "cc".repeat(20),
          topics: [TRANSFER_TOPIC, "0x" + "0".repeat(64), "0x" + me.slice(2).padStart(64, "0"), "0x" + "9".padStart(64, "0")],
          data: "0x",
        },
        {
          address: cpu,
          topics: [TRANSFER_TOPIC, "0x" + "0".repeat(64), "0x" + me.slice(2).padStart(64, "0"), "0x" + "7".padStart(64, "0")],
          data: "0x",
        },
      ],
    };
    expect(mintedId(r, cpu, me)).toBe(7n);
    expect(() => mintedId({ ...r, logs: [] }, cpu, me)).toThrow("no circuit mint");
  });

  it("waits for a receipt, and refuses a reverted transaction", async () => {
    let n = 0;
    const slow: Fetch = async (_u, init) => {
      const req = JSON.parse(init.body) as { id: number };
      n++;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: req.id, result: n < 3 ? null : { status: "0x1", logs: [], gasUsed: "0x5", blockNumber: "0x9" } }),
      };
    };
    const r = await waitReceipt(new JsonRpc("x", slow), "0xabc", 10_000, async () => undefined);
    expect(r.gasUsed).toBe("0x5");
    const failed: Fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: { status: "0x0", logs: [], gasUsed: "0x5", blockNumber: "0x9" } }),
    });
    await expect(waitReceipt(new JsonRpc("x", failed), "0xdef", 10_000, async () => undefined)).rejects.toThrow("reverted");
    const never: Fetch = async () => ({ ok: true, status: 200, json: async () => ({ result: null }) });
    await expect(waitReceipt(new JsonRpc("x", never), "0x1", -1, async () => undefined)).rejects.toThrow("no receipt");
  });

  it("connects a wallet and adds X Layer when the wallet does not know it", async () => {
    const calls: string[] = [];
    const w: Eip1193 = {
      async request({ method }) {
        calls.push(method);
        if (method === "eth_requestAccounts") return ["0xABCDEF0000000000000000000000000000000001"];
        if (method === "wallet_switchEthereumChain") throw Object.assign(new Error("unknown chain"), { code: 4902 });
        return null;
      },
    };
    expect(await connectWallet(w)).toBe("0xabcdef0000000000000000000000000000000001");
    expect(calls).toEqual(["eth_requestAccounts", "wallet_switchEthereumChain", "wallet_addEthereumChain"]);
  });

  it("passes on a wallet refusal", async () => {
    const w: Eip1193 = {
      async request({ method }) {
        if (method === "eth_requestAccounts") return ["0x01"];
        throw Object.assign(new Error("User rejected the request."), { code: 4001 });
      },
    };
    await expect(connectWallet(w)).rejects.toThrow("User rejected");
  });

  it("reads prices and balances, for OKB-priced and BEM-priced transistors", async () => {
    const enc = (v: bigint) => encodeAbiParameters([{ type: "uint256" }], [v]);
    const addr = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
    const make =
      (bem: boolean): Fetch =>
      async (_u, init) => {
        const req = JSON.parse(init.body) as { params: [{ data: string }]; id: number };
        const sel = req.params[0].data.slice(0, 10);
        const map: Record<string, string> = {
          [WSEL.transistors]: addr("0x" + "22".repeat(20)),
          [WSEL.TAPEOUT_FEE]: enc(1_300_000_000_000_000n),
          [WSEL.mintPrice]: enc(100n),
          [WSEL.protocolFee]: enc(1_000_000n),
          [WSEL.balanceOf1155]: enc(12n),
        };
        if (sel === WSEL.BEM && !bem)
          return { ok: true, status: 200, json: async () => ({ id: req.id, error: { code: 3, message: "execution reverted" } }) };
        const result = sel === WSEL.BEM ? addr("0x60e62efa9405d6873c5deabd4e6cc91c25363952") : map[sel];
        return { ok: true, status: 200, json: async () => ({ id: req.id, result }) };
      };
    const okb = await pricing(new JsonRpc("x", make(false)), "0x" + "11".repeat(20), "0x" + "33".repeat(20));
    expect(okb).toMatchObject({ tapeoutFee: 1_300_000_000_000_000n, mintPrice: 100n, payToken: null, nand: 12n, latch: 12n });
    const bem = await pricing(new JsonRpc("x", make(true)), "0x" + "11".repeat(20), "0x" + "33".repeat(20));
    expect(bem.payToken).toBe("0x60e62efa9405d6873c5deabd4e6cc91c25363952");
    expect(mintCost(bem, 0n)).toBe(0n);
    expect(mintCost(bem, 10n)).toBe(1_000n + 1_000_000n);
  });
});
