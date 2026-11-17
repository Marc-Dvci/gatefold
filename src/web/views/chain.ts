/**
 * X Layer: read any TapeOut circuit, draw it, play it, and check this page's evaluator against the chain.
 */
import { decodeResult, encodeCall } from "../../chain/abi";
import { type ChainCircuit, Processor, SEL, loadFromChain } from "../../chain/processor";
import { JsonRpc, XLAYER } from "../../chain/rpc";
import { flatten, simplify } from "../../core/flat";
import { OP_REF, beat, bytesToHex, decode, intToBits, refKey } from "../../core/tap02";
import { DEPLOYMENT } from "../../deployments";
import { player } from "../audio";
import { library } from "../catalog";
import { DieView } from "../die";
import { drawScope } from "./listen";
import { fmt, h } from "../ui";

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}

function randomBits(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.random() < 0.5 ? 1 : 0;
  return b;
}

/** Compare k random beats of a loaded circuit with the chain (step, or eval for a circuit without state). */
export async function checkAgainstChain(
  rpc: JsonRpc,
  c: ChainCircuit,
  k: number,
): Promise<{ checked: number; matched: number; ms: number }> {
  const p = new Processor(rpc, c.cpu);
  let matched = 0;
  const t0 = performance.now();
  for (let i = 0; i < k; i++) {
    const state = randomBits(c.circuit.nState);
    const inputs = randomBits(c.circuit.nIn);
    const local = beat(c.circuit, state, inputs);
    if (c.circuit.nState === 0) {
      const out = await p.eval(c.id, c.circuit.nOut, inputs);
      if (bytesToHex(out) === bytesToHex(local.outputs)) matched++;
    } else {
      const r = await p.step(c.id, c.circuit.nState, c.circuit.nOut, state, inputs);
      if (bytesToHex(r.outputs) === bytesToHex(local.outputs) && bytesToHex(r.newState) === bytesToHex(local.newState)) matched++;
    }
  }
  return { checked: k, matched, ms: performance.now() - t0 };
}

export function chainView(root: HTMLElement): () => void {
  const rpc = new JsonRpc();
  const lib = library();
  const known = lib.resolver();
  const head = h("p", { class: "chain-head", role: "status" }, "Reading X Layer…");
  const rows = h("tbody");
  const sampleOut = h("p", { class: "muted small", role: "status" });
  const canvas = h("canvas", { class: "die small-die", role: "img", "aria-label": "The loaded circuit drawn as a chip" });
  const die = new DieView(canvas);
  const scope = h("canvas", { class: "scope", "aria-hidden": "true" });
  const info = h("div", { class: "circuit-info" });
  const cpuIn = h("input", {
    type: "text",
    // Gatefold's own theme once it is pressed; before that, a public TapeOut processor's first circuit.
    value: DEPLOYMENT?.processor ?? "0xCE56B1f17B7C270A0D5e0E8a097Ae5ab71D85BD5",
    spellcheck: false,
    "aria-label": "Processor address",
    class: "mono",
  });
  const idIn = h("input", { type: "number", value: DEPLOYMENT?.songs["gatefold-theme"] ?? "1", min: "1", "aria-label": "Circuit id" });
  let loaded: ChainCircuit | null = null;
  let disposed = false;

  void (async () => {
    try {
      const t0 = performance.now();
      const [block, count] = await Promise.all([rpc.blockNumber(), rpc.call(XLAYER.factory, SEL.cpuCount)]);
      const ms = Math.round(performance.now() - t0);
      if (disposed) return;
      head.textContent = `Block ${fmt.int(block)} · ${fmt.int(decodeResult(count, ["uint"])[0] as bigint)} TapeOut processors on X Layer · node answered in ${ms} ms`;
      await open();
    } catch (e) {
      head.textContent = `X Layer did not answer: ${(e as Error).message}`;
    }
  })();

  async function sample(): Promise<void> {
    rows.replaceChildren();
    sampleOut.textContent = "Picking circuits at random from the factory…";
    let total = 0;
    let ok = 0;
    let circuits = 0;
    const count = Number(decodeResult(await rpc.call(XLAYER.factory, SEL.cpuCount), ["uint"])[0]);
    for (let tries = 0; circuits < 6 && tries < 30 && !disposed; tries++) {
      try {
        const cpu = decodeResult(await rpc.call(XLAYER.factory, encodeCall(SEL.cpuAt, [{ type: "uint", value: rand(count) }])), [
          "address",
        ])[0] as string;
        const next = await new Processor(rpc, cpu).nextId();
        if (next <= 1n) continue;
        const id = BigInt(1 + rand(Number(next - 1n)));
        const c = await loadFromChain(rpc, cpu, id);
        if (c.circuit.nGates > 4000) continue;
        const r = await checkAgainstChain(rpc, c, 4);
        circuits++;
        total += r.checked;
        ok += r.matched;
        rows.append(
          h(
            "tr",
            null,
            h("td", null, h("code", null, fmt.addr(cpu))),
            h("td", null, `#${id}`),
            h("td", null, fmt.int(c.circuit.nGates)),
            h("td", null, String(c.circuit.nState)),
            h("td", null, c.circuit.nState ? "step" : "eval"),
            h("td", { "data-ok": String(r.matched === r.checked) }, `${r.matched}/${r.checked}`),
          ),
        );
        sampleOut.textContent = `${ok} of ${total} beats identical across ${circuits} circuit${circuits === 1 ? "" : "s"}.`;
      } catch {
        /* a processor without readable circuits: try another */
      }
    }
  }

  async function open(): Promise<void> {
    info.replaceChildren(h("p", { class: "muted" }, "Reading the circuit and everything it references…"));
    try {
      const c = await loadFromChain(rpc, cpuIn.value.trim(), BigInt(idIn.value), "latest", known);
      loaded = c;
      const p = simplify(flatten(c.circuit));
      die.setProgram(
        p,
        (i) => (i === 0 ? "logic" : "referenced"),
        (i) => (i === 0 ? `circuit #${c.id}` : `REF #${p.instances[i]!.id}`),
        new Uint8Array(c.circuit.nIn),
      );
      const owner = await new Processor(rpc, c.cpu).ownerOf(c.id).catch(() => "");
      // The distinct circuits its own netlist names in REF records (instruments this page knows are not fetched again).
      const refs = new Set(decode(c.bytes, c.info.nIn).flatMap((e) => (e.op === OP_REF ? [refKey(e.cpu, e.id)] : []))).size;
      const out = h("p", { class: "verify-out", role: "status" });
      info.replaceChildren(
        h(
          "dl",
          { class: "facts compact" },
          h("div", null, h("dt", null, "Pins"), h("dd", null, `${c.circuit.nIn} in · ${c.circuit.nOut} out`)),
          h("div", null, h("dt", null, "Gates"), h("dd", null, fmt.int(c.circuit.nGates))),
          h("div", null, h("dt", null, "State"), h("dd", null, `${c.circuit.nState} bits`)),
          h("div", null, h("dt", null, "Netlist"), h("dd", null, `${fmt.int(c.bytes.length)} bytes`)),
          h("div", null, h("dt", null, "References"), h("dd", null, `${refs} circuit${refs === 1 ? "" : "s"}`)),
          owner ? h("div", null, h("dt", null, "Owner"), h("dd", null, h("code", null, fmt.addr(owner)))) : null,
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              onclick: async () => {
                out.textContent = "Checking 8 random beats against X Layer…";
                const r = await checkAgainstChain(rpc, c, 8);
                out.textContent = `${r.matched} of ${r.checked} beats identical to the chain (${Math.round(r.ms / r.checked)} ms per call).`;
                out.dataset.ok = String(r.matched === r.checked);
              },
            },
            "Check 8 beats on chain",
          ),
          h(
            "button",
            {
              type: "button",
              class: "ghost",
              onclick: async () => {
                const prog = simplify(flatten(c.circuit));
                const width = Math.min(16, prog.outputs.length);
                const trimmed = { ...prog, nOut: width, outputs: prog.outputs.slice(prog.outputs.length - width) };
                await player.load(`raw:${c.cpu}:${c.id}`, trimmed, "raw", 2 ** width - 1, intToBits(0, c.circuit.nIn));
                await player.play();
              },
            },
            "Listen to its outputs",
          ),
        ),
        out,
      );
    } catch (e) {
      info.replaceChildren(h("p", { class: "error" }, (e as Error).message));
    }
  }

  const view = h(
    "section",
    { class: "chainview" },
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "X Layer"),
      h(
        "p",
        { class: "lede" },
        "Gatefold reads TapeOut circuits straight from X Layer and evaluates them with the TAP-02 semantics. Check it yourself: pick circuits at random and compare this page's answer with the chain's own step and eval.",
      ),
      head,
    ),
    h(
      "div",
      { class: "chain-grid" },
      h(
        "section",
        null,
        h("h2", null, "Random circuits, checked against the chain"),
        h("button", { type: "button", class: "primary", onclick: () => void sample() }, "Check 6 random circuits"),
        sampleOut,
        h(
          "table",
          { class: "sample" },
          h(
            "thead",
            null,
            h("tr", null, ...["Processor", "Circuit", "Gates", "State", "Call", "Same"].map((t) => h("th", { scope: "col" }, t))),
          ),
          rows,
        ),
      ),
      h(
        "section",
        null,
        h("h2", null, "Open any circuit"),
        h("div", { class: "row" }, cpuIn, idIn, h("button", { type: "button", class: "ghost", onclick: () => void open() }, "Open")),
        canvas,
        info,
        scope,
      ),
    ),
  );
  root.replaceChildren(view);
  const offFrame = player.onFrame((f) => {
    if (!loaded || !player.loadedKey.startsWith("raw:")) return;
    die.update(f.state);
    drawScope(scope, f.scope);
  });
  return () => {
    disposed = true;
    offFrame();
  };
}
