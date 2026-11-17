/**
 * The few Solidity ABI shapes Gatefold sends and reads, with no dependency, so the page stays small enough to live
 * on chain. The tests hold every encoder and decoder to viem's.
 */
import { bytesToHex, hexToBytes } from "../core/tap02";

const WORD = 32;

function word(v: bigint): string {
  if (v < 0n || v >= 1n << 256n) throw new Error("value out of uint256 range");
  return v.toString(16).padStart(64, "0");
}

function encodeBytesTail(b: Uint8Array): string {
  const hex = bytesToHex(b).slice(2);
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
  return word(BigInt(b.length)) + padded;
}

export type AbiValue =
  | { type: "uint"; value: bigint | number }
  | { type: "address"; value: string }
  | { type: "bytes"; value: Uint8Array }
  | { type: "bytes32"; value: string }
  | { type: "bool"; value: boolean };

/** ABI-encode arguments (head and tail) after a 4-byte selector. */
export function encodeCall(selector: string, args: AbiValue[]): string {
  if (!/^0x[0-9a-f]{8}$/i.test(selector)) throw new Error("selector must be 4 bytes");
  const heads: string[] = [];
  const tails: string[] = [];
  let tailOffset = args.length * WORD;
  for (const a of args) {
    switch (a.type) {
      case "uint":
        heads.push(word(BigInt(a.value)));
        break;
      case "bool":
        heads.push(word(a.value ? 1n : 0n));
        break;
      case "address": {
        if (!/^0x[0-9a-fA-F]{40}$/.test(a.value)) throw new Error("invalid address");
        heads.push(a.value.slice(2).toLowerCase().padStart(64, "0"));
        break;
      }
      case "bytes32": {
        if (!/^0x[0-9a-fA-F]{64}$/.test(a.value)) throw new Error("invalid bytes32");
        heads.push(a.value.slice(2).toLowerCase());
        break;
      }
      case "bytes": {
        heads.push(word(BigInt(tailOffset)));
        const t = encodeBytesTail(a.value);
        tails.push(t);
        tailOffset += t.length / 2;
        break;
      }
    }
  }
  return selector.toLowerCase() + heads.join("") + tails.join("");
}

function readWord(data: Uint8Array, at: number): bigint {
  if (at + WORD > data.length) throw new Error("ABI data too short");
  let v = 0n;
  for (let i = 0; i < WORD; i++) v = (v << 8n) | BigInt(data[at + i]!);
  return v;
}

function readBytesAt(data: Uint8Array, offset: number): Uint8Array {
  const len = Number(readWord(data, offset));
  if (offset + WORD + len > data.length) throw new Error("ABI bytes out of range");
  return data.slice(offset + WORD, offset + WORD + len);
}

/** Decode return data made of the given types (uint, address, bool, bytes). */
export function decodeResult(
  hex: string,
  types: Array<"uint" | "address" | "bool" | "bytes">,
): Array<bigint | string | boolean | Uint8Array> {
  const data = hexToBytes(hex);
  return types.map((t, i) => {
    const w = readWord(data, i * WORD);
    switch (t) {
      case "uint":
        return w;
      case "bool":
        return w !== 0n;
      case "address":
        return "0x" + w.toString(16).padStart(40, "0").slice(-40);
      case "bytes":
        return readBytesAt(data, Number(w));
    }
  });
}

/** Decode a revert payload `Error(string)` into its message, if it is one. */
export function revertReason(hex: string | undefined): string | undefined {
  if (!hex || !hex.toLowerCase().startsWith("0x08c379a0")) return undefined;
  try {
    const [msg] = decodeResult("0x" + hex.slice(10), ["bytes"]) as [Uint8Array];
    return new TextDecoder().decode(msg);
  } catch {
    return undefined;
  }
}

export { bytesToHex, hexToBytes };
