/**
 * Liner notes: how a song becomes a chip, and which parts of TapeOut and X Layer do the work.
 */
import { BEAT_RATE } from "../../core/instruments";
import { cdWavBytes } from "../../core/render";
import { CATALOG, prepare } from "../catalog";
import { fmt, h } from "../ui";

export function howView(root: HTMLElement): () => void {
  const first = prepare(CATALOG[0]!.song).cs;
  const secs = first.beats / BEAT_RATE;
  const steps: Array<[string, string]> = [
    ["Score", "Each channel is a line of MML. The compiler reads it into notes on a grid of rows."],
    [
      "Gates",
      "The compiler builds the song as NAND and LATCH gates: a clock, a row counter, one ROM per channel built as a reduced decision diagram, a note table, and a mixer. Identical aligned passages of the score share the same gates.",
    ],
    [
      "Instruments by reference",
      "Each channel drives an instrument circuit through a TAP-02 REF record: pulse, triangle, noise, kick and arpeggio. A tape-out burns transistors only for the song's own gates.",
    ],
    ["Netlist", `The result is a TAP-02 netlist: ${fmt.int(first.build.bytes.length)} bytes for "${first.song.title}", against ${fmt.bytes(cdWavBytes(secs))} for the same ${Math.round(secs)} seconds as a CD-quality WAV.`],
    ["Tape-out", "One transaction stores the netlist on a TapeOut processor on X Layer and mints it as a circuit NFT."],
    [
      "Playback",
      `The player reads the netlist back from X Layer, inlines every REF, compiles the gates to JavaScript and runs them in an AudioWorklet, ${fmt.int(BEAT_RATE)} beats a second. One beat is one sample.`,
    ],
    ["Proof", "Any beat can be sent to the processor's own step() through eth_call: the chain returns the same next state and the same sample."],
  ];
  const uses: Array<[string, string]> = [
    ["TapeOut circuits (NAND, LATCH, REF)", "Every song and every instrument is a circuit; LATCH holds oscillators, envelopes and the song position; REF puts instruments inside songs."],
    ["Processor step() and eval()", "The chain recomputes any beat on request, so a listener can check that the player plays the chain's circuit."],
    ["DeWEB and TapeKit", "Gatefold is a static site with no server; its only network request goes to rpc.xlayer.tech, the node a TapeKit gateway counts as the site's own."],
    ["X Layer and USD₮0", "Tape-outs, circuit ownership, and licences paid in USD₮0 with one signed authorization (EIP-3009), split along the REF lineage by the Gatefold Records contract."],
  ];
  root.replaceChildren(
    h(
      "section",
      { class: "how" },
      h("header", { class: "page-head" }, h("h1", null, "Liner notes"), h("p", { class: "lede" }, "How a song becomes a chip on X Layer, and why the chain bytes are the song.")),
      h("ol", { class: "steps" }, ...steps.map(([t, d], i) => h("li", null, h("span", { class: "n" }, String(i + 1).padStart(2, "0")), h("div", null, h("h2", null, t), h("p", null, d))))),
      h("h2", null, "What each part of the ecosystem does here"),
      h("table", { class: "uses" }, h("tbody", null, ...uses.map(([a, b]) => h("tr", null, h("th", { scope: "row" }, a), h("td", null, b))))),
      h(
        "p",
        { class: "muted" },
        "Source, tests and the TAP-02 conformance runs: ",
        h("a", { href: "https://github.com/Marc-Dvci/gatefold", rel: "noopener" }, "github.com/Marc-Dvci/gatefold"),
        ".",
      ),
    ),
  );
  return () => undefined;
}
