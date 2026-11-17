import fc from "fast-check";
import {
  type Hex,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  recoverTypedDataAddress,
  toFunctionSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type Lineage,
  MAX_BPS,
  RSEL,
  TERMS,
  authorizationTypedData,
  buyLicence,
  licenceNonce,
  licenseWithAuthorizationData,
  readFeeBps,
  readLicensed,
  readOwed,
  readOwner,
  readParents,
  readRelease,
  readUsdt0,
  chainLineage,
  randomSalt,
  refTargets,
  releaseKey,
  splitLicence,
  splitSignature,
  usdt0,
  withdrawData,
} from "../src/chain/records";
import { type Fetch, JsonRpc, XLAYER } from "../src/chain/rpc";
import type { Eip1193 } from "../src/chain/tapeout";
import { type Song, compileSong, localLibrary } from "../src/core/song";
import theme from "../songs/gatefold-theme.json";

const recordsAbi = parseAbi([
  "function releases(bytes32) view returns (address cpu, uint64 id, uint128 price, uint16 upstreamBps, bool exists)",
  "function feeBps() view returns (uint16)",
  "function parentsOf(bytes32 key) view returns (bytes32[])",
  "function owed(address) view returns (uint256)",
  "function withdraw()",
  "function isLicensed(address cpu, uint256 id, address licensee) view returns (bool)",
  "function licenseWithAuthorization(bytes32 key, address licensee, bytes32 salt, address from, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function ownerOf(uint256 id) view returns (address)",
  "function balanceOf(address) view returns (uint256)",
]);

const CPU = "0x1900801e311184063b9d9c119c9d98aa4950e12c";
const RECORDS = "0xd2d50e234c6826010f6029b373b5551803a1c49c";
const GAME = "0x00000000000000000000000000000000006a3e01";
const SALT = ("0x" + "5a".repeat(32)) as Hex;

describe("Gatefold Records calls, held to viem", () => {
  it("every selector is the keccak of its signature", () => {
    const sigs: Record<string, string> = {
      [RSEL.releases]: "releases(bytes32)",
      [RSEL.feeBps]: "feeBps()",
      [RSEL.parentsOf]: "parentsOf(bytes32)",
      [RSEL.owed]: "owed(address)",
      [RSEL.withdraw]: "withdraw()",
      [RSEL.isLicensed]: "isLicensed(address,uint256,address)",
      [RSEL.licenseWithAuthorization]: "licenseWithAuthorization(bytes32,address,bytes32,address,uint256,uint256,uint8,bytes32,bytes32)",
      [RSEL.ownerOf]: "ownerOf(uint256)",
      [RSEL.balanceOf]: "balanceOf(address)",
    };
    for (const [sel, sig] of Object.entries(sigs)) expect(sel).toBe(toFunctionSelector(`function ${sig}`));
  });

  it("the release key and the licence nonce are the contract's keccak256(abi.encode(...))", () => {
    const key = releaseKey(CPU, 6n);
    expect(key).toBe(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [CPU, 6n])));
    expect(licenceNonce(key, GAME, SALT)).toBe(
      keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "bytes32" }], [key as Hex, GAME, SALT])),
    );
  });

  it("licence calldata matches viem", () => {
    const a = {
      key: releaseKey(CPU, 7n),
      licensee: GAME,
      salt: SALT,
      from: ("0x" + "ab".repeat(20)) as Hex,
      validAfter: 0n,
      validBefore: 1_800_000_000n,
      v: 28,
      r: "0x" + "11".repeat(32),
      s: "0x" + "22".repeat(32),
    };
    expect(licenseWithAuthorizationData(a)).toBe(
      encodeFunctionData({
        abi: recordsAbi,
        functionName: "licenseWithAuthorization",
        args: [a.key as Hex, a.licensee as Hex, a.salt, a.from as Hex, a.validAfter, a.validBefore, a.v, a.r as Hex, a.s as Hex],
      }),
    );
  });

  it("splits a signature into v, r and s, and refuses a malformed one", () => {
    const sig = "0x" + "11".repeat(32) + "22".repeat(32) + "01";
    expect(splitSignature(sig)).toEqual({ v: 28, r: "0x" + "11".repeat(32), s: "0x" + "22".repeat(32) });
    expect(splitSignature(sig.slice(0, -2) + "1b").v).toBe(27);
    expect(() => splitSignature("0x1234")).toThrow(/malformed/);
  });

  it("formats USD₮0 base units", () => {
    expect(usdt0(5_000_000n)).toBe("5");
    expect(usdt0(292_500n)).toBe("0.2925");
    expect(usdt0(3_412_500n)).toBe("3.4125");
    expect(usdt0(0n)).toBe("0");
  });
});

/** The Gatefold theme's lineage: the song and the five instruments its REF records name. */
function themeLineage(upstreamBps: number): Lineage {
  const names = ["pulse", "triangle", "arp", "kick", "noise"];
  return {
    key: "song",
    label: "Song owner",
    upstreamBps,
    parents: names.map((n) => ({ key: n, label: n, upstreamBps: 0, parents: [] })),
  };
}

describe("the split of one licence, as GatefoldRecords computes it", () => {
  it("5 USD₮0 at 2.5 % and a 30 % upstream share over five instruments", () => {
    const credits = splitLicence(TERMS.songPrice, TERMS.feeBps, themeLineage(TERMS.songUpstreamBps));
    expect(credits.map((c) => [c.key, c.amount])).toEqual([
      ["fee", 125_000n],
      ["pulse", 292_500n],
      ["triangle", 292_500n],
      ["arp", 292_500n],
      ["kick", 292_500n],
      ["noise", 292_500n],
      ["song", 3_412_500n],
    ]);
  });

  it("follows the Foundry test of a remix: remixer, then the song, then its instruments", () => {
    const price = 1_000_000n;
    const song: Lineage = {
      key: "artist",
      label: "artist",
      upstreamBps: 5_000,
      parents: [1, 2, 3].map((i) => ({ key: `maker${i}`, label: "maker", upstreamBps: 0, parents: [] })),
    };
    const credits = Object.fromEntries(
      splitLicence(price, 250, { key: "remixer", label: "remixer", upstreamBps: 4_000, parents: [song] }).map((c) => [c.key, c.amount]),
    );
    const rest = price - (price * 250n) / 10_000n;
    const toSong = (rest * 4_000n) / 10_000n;
    const each = (toSong * 5_000n) / 10_000n / 3n;
    expect(credits.remixer).toBe(rest - toSong);
    expect(credits.artist).toBe(toSong - each * 3n);
    expect(credits.maker1! + credits.maker2! + credits.maker3!).toBe(each * 3n);
  });

  it("stops passing shares up at the contract's depth limit", () => {
    // A chain of five releases, each passing half up: only three levels pass anything on.
    let r: Lineage = { key: "l4", label: "l4", upstreamBps: 5_000, parents: [] };
    for (let i = 3; i >= 0; i--) r = { key: `l${i}`, label: `l${i}`, upstreamBps: 5_000, parents: [r] };
    const keys = splitLicence(1_000_000n, 0, r).map((c) => c.key);
    expect(keys).toEqual(["l3", "l2", "l1", "l0"]);
  });

  it("a free release credits nobody", () => {
    expect(splitLicence(0n, 250, themeLineage(3_000))).toEqual([]);
  });

  it("the credits always add up to the price", () => {
    // Lineages up to five levels deep (two beyond the contract's depth limit), up to three parents each.
    const node = (depth: number): fc.Arbitrary<Lineage> =>
      fc.record({
        key: fc.nat({ max: 999 }).map(String),
        label: fc.constant("x"),
        upstreamBps: fc.integer({ min: 0, max: MAX_BPS }),
        parents: depth === 0 ? fc.constant([]) : fc.array(node(depth - 1), { maxLength: 3 }),
      });
    const lineage = node(4);
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), fc.integer({ min: 0, max: 1_000 }), lineage, (price, fee, l) => {
        const total = splitLicence(price, fee, l).reduce((s, c) => s + c.amount, 0n);
        expect(total).toBe(price);
      }),
      { numRuns: 300 },
    );
  });
});

describe("the REF records a release's parents come from", () => {
  it("are the instruments of each channel, in record order", () => {
    const lib = localLibrary();
    const cs = compileSong(theme as Song, lib);
    const refs = refTargets(cs.build.bytes, cs.build.nIn);
    expect(refs).toHaveLength(cs.build.refs);
    expect(refs.map((r) => r.id)).toEqual((theme as Song).channels.map((c) => lib.get(c.instrument).target.id));
    for (const r of refs) expect(r.cpu).toBe(lib.cpu.toLowerCase());
  });
});

/** A node that answers eth_call from a table keyed by calldata. */
function node(answers: Record<string, string>): JsonRpc {
  const f: Fetch = async (_u, init) => {
    const req = JSON.parse(init.body) as { id: number; params: Array<{ to: string; data: string }> };
    const { to, data } = req.params[0]!;
    const result = answers[`${to.toLowerCase()}:${data}`];
    if (result === undefined)
      return { ok: true, status: 200, json: async () => ({ id: req.id, error: { code: 3, message: "execution reverted" } }) };
    return { ok: true, status: 200, json: async () => ({ id: req.id, jsonrpc: "2.0", result }) };
  };
  return new JsonRpc("http://node", f);
}

describe("reading Gatefold Records", () => {
  const key = releaseKey(CPU, 6n) as Hex;
  const parents = ["pulse", "triangle"].map((_, i) => releaseKey(CPU, BigInt(i + 1)) as Hex);
  const account = "0x" + "cd".repeat(20);
  const call = (functionName: string, args: unknown[]): string =>
    encodeFunctionData({ abi: recordsAbi, functionName: functionName as never, args: args as never });
  const result = (functionName: string, value: unknown): string =>
    encodeFunctionResult({ abi: recordsAbi, functionName: functionName as never, result: value as never });
  const rpc = node({
    [`${RECORDS}:${call("releases", [key])}`]: result("releases", [CPU, 6n, 5_000_000n, 3_000, true]),
    [`${RECORDS}:${call("feeBps", [])}`]: result("feeBps", 250),
    [`${RECORDS}:${call("parentsOf", [key])}`]: result("parentsOf", parents),
    [`${RECORDS}:${call("owed", [account])}`]: result("owed", 292_500n),
    [`${RECORDS}:${call("isLicensed", [CPU, 6n, GAME])}`]: result("isLicensed", true),
    [`${CPU}:${call("ownerOf", [6n])}`]: result("ownerOf", account),
    [`${XLAYER.usdt0}:${call("balanceOf", [account])}`]: result("balanceOf", 12_000_000n),
    ...Object.fromEntries(
      parents.map((pk, i) => [`${RECORDS}:${call("releases", [pk])}`, result("releases", [CPU, BigInt(i + 1), 0n, 0, true])]),
    ),
  });

  it("reads a release, the fee, the parents and the payees' balances", async () => {
    expect(await readRelease(rpc, RECORDS, key)).toEqual({ price: 5_000_000n, upstreamBps: 3_000, exists: true });
    expect(await readFeeBps(rpc, RECORDS)).toBe(250);
    expect(await readParents(rpc, RECORDS, key)).toEqual(parents);
    expect(await readOwed(rpc, RECORDS, account)).toBe(292_500n);
    expect(await readLicensed(rpc, RECORDS, CPU, 6n, GAME)).toBe(true);
    expect(await readOwner(rpc, CPU, 6n)).toBe(account);
    expect(await readUsdt0(rpc, account)).toBe(12_000_000n);
  });

  it("reads a song's lineage as the contract recorded it, and the split follows it", async () => {
    const names: Record<string, string> = { [key]: "Song owner", [parents[0]!]: "Pulse", [parents[1]!]: "Triangle" };
    const lineage = await chainLineage(rpc, RECORDS, key, (k) => names[k]!);
    expect(lineage).toEqual({
      key,
      label: "Song owner",
      upstreamBps: 3_000,
      parents: parents.map((k) => ({ key: k, label: names[k], upstreamBps: 0, parents: [] })),
    });
    expect(splitLicence(5_000_000n, 250, lineage).map((c) => [c.label, c.amount])).toEqual([
      ["Gatefold fee", 125_000n],
      ["Pulse", 731_250n],
      ["Triangle", 731_250n],
      ["Song owner", 3_412_500n],
    ]);
  });

  it("withdraw calldata and fresh salts", () => {
    expect(withdrawData()).toBe(encodeFunctionData({ abi: recordsAbi, functionName: "withdraw" }));
    const a = randomSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(randomSalt()).not.toBe(a);
  });

  it("refuses a parents list longer than the contract allows", async () => {
    const many = Array.from({ length: 9 }, (_, i) => releaseKey(CPU, BigInt(i)) as Hex);
    const bad = node({ [`${RECORDS}:${call("parentsOf", [key])}`]: result("parentsOf", many) });
    await expect(readParents(bad, RECORDS, key)).rejects.toThrow(/malformed/);
  });
});

interface TypedJson {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, string>;
}

/** eth_signTypedData_v4 JSON (numbers as decimal strings) to viem's typed-data parameters. */
function toViem(td: TypedJson): Parameters<ReturnType<typeof privateKeyToAccount>["signTypedData"]>[0] {
  const types = Object.fromEntries(Object.entries(td.types).filter(([k]) => k !== "EIP712Domain"));
  const message = Object.fromEntries(Object.entries(td.message).map(([k, v]) => [k, /^\d+$/.test(v) ? BigInt(v) : v]));
  return { domain: td.domain, types, primaryType: td.primaryType, message } as never;
}

describe("buying a licence through a wallet", () => {
  it("signs one USD₮0 authorization bound to the song and the licensee, and sends it to Gatefold Records", async () => {
    const buyer = privateKeyToAccount(("0x" + "42".repeat(32)) as Hex);
    const sent: Array<{ from: string; to: string; data: string }> = [];
    const wallet: Eip1193 = {
      async request({ method, params }) {
        if (method === "eth_signTypedData_v4") {
          const [from, json] = params as [string, string];
          expect(from).toBe(buyer.address.toLowerCase());
          return buyer.signTypedData(toViem(JSON.parse(json) as TypedJson));
        }
        if (method === "eth_sendTransaction") {
          sent.push((params as Array<{ from: string; to: string; data: string }>)[0]!);
          return "0x" + "ee".repeat(32);
        }
        throw new Error(`unexpected ${method}`);
      },
    };
    const account = buyer.address.toLowerCase();
    const hash = await buyLicence(
      wallet,
      { account, records: RECORDS, cpu: CPU, id: 6n, licensee: GAME, price: 5_000_000n, now: 1_800_000_000n },
      SALT,
    );
    expect(hash).toBe("0x" + "ee".repeat(32));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(RECORDS);
    const { args } = decodeFunctionData({ abi: recordsAbi, data: sent[0]!.data as Hex });
    const [key, licensee, salt, from, validAfter, validBefore, v, r, s] = args as unknown as [
      Hex,
      string,
      Hex,
      string,
      bigint,
      bigint,
      number,
      Hex,
      Hex,
    ];
    expect(key).toBe(releaseKey(CPU, 6n));
    expect(licensee.toLowerCase()).toBe(GAME);
    expect(salt).toBe(SALT);
    expect(validBefore).toBe(1_800_003_600n);
    // The signature in the calldata recovers to the buyer, for the message USD₮0 rebuilds from the call.
    const typed = authorizationTypedData({
      from,
      to: RECORDS,
      value: 5_000_000n,
      validAfter,
      validBefore,
      nonce: licenceNonce(key, licensee, salt),
    });
    const signer = await recoverTypedDataAddress({
      ...toViem(JSON.parse(JSON.stringify(typed)) as TypedJson),
      signature: (r + s.slice(2) + v.toString(16)) as Hex,
    });
    expect(signer).toBe(buyer.address);
  });
});
