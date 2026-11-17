/**
 * Listen: a release laid out as an open gatefold sleeve. On the left the cover, which is the song's own circuit
 * drawn as a chip and lit while it plays; on the right the liner notes: tracks, pins, meters, and the chain record.
 */
import { Processor } from "../../chain/processor";
import { JsonRpc } from "../../chain/rpc";
import { BEAT_RATE } from "../../core/instruments";
import { cdWavBytes } from "../../core/render";
import { LOCAL_CPU, PIN_NAMES } from "../../core/song";
import { beat, bytesToHex } from "../../core/tap02";
import { DEPLOYMENT } from "../../deployments";
import { player } from "../audio";
import { CATALOG, type CatalogSong, pinBits, prepare, songOnChain } from "../catalog";
import { DieView } from "../die";
import { fmt, h, sha256 } from "../ui";
import { licencePanel } from "./licence";

export interface ListenState {
  intensity: number;
  drive: boolean;
}

export const listenState: ListenState = { intensity: 3, drive: false };

export function drawScope(canvas: HTMLCanvasElement, data: Float32Array | null): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const d = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = canvas.clientWidth || 300;
  const hh = canvas.clientHeight || 60;
  if (canvas.width !== w * d) {
    canvas.width = w * d;
    canvas.height = hh * d;
  }
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.clearRect(0, 0, w, hh);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.beginPath();
  ctx.moveTo(0, hh / 2);
  ctx.lineTo(w, hh / 2);
  ctx.stroke();
  if (!data) return;
  ctx.strokeStyle = "#34d1bf";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = (i / (data.length - 1)) * w;
    const y = hh / 2 - data[i]! * hh * 0.55;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function listenView(root: HTMLElement, slug: string | undefined): () => void {
  const entry: CatalogSong = CATALOG.find((c) => c.slug === slug) ?? CATALOG[0]!;
  const { song } = entry;
  const prep = prepare(song);
  const { cs, program } = prep;
  const seconds = cs.beats / BEAT_RATE;
  const wavBytes = cdWavBytes(seconds);
  const ownGates = cs.build.nand + cs.build.latch;
  const totalGates = cs.circuit.nGates;
  const onChain = songOnChain(entry.slug);
  const key = `song:${prep.key}`;

  const canvas = h("canvas", {
    class: "die",
    role: "img",
    "aria-label": `The circuit of ${song.title} drawn as a chip: ${fmt.int(totalGates)} gates, each cell lit when its gate changes`,
  });
  const die = new DieView(canvas);

  const playBtn = h("button", { class: "play", type: "button", "aria-label": "Play" }, "Play");
  const time = h("span", { class: "time" }, `0:00 / ${fmt.secs(seconds)}`);
  const engineNote = h("span", { class: "muted small" });
  const scope = h("canvas", { class: "scope", "aria-hidden": "true" });

  const meters = song.channels.map((ch, i) => {
    const bar = h("span", { class: "meter-fill" });
    const row = h(
      "li",
      { class: "meter" },
      h("span", { class: "meter-name" }, ch.name),
      h("span", { class: "meter-inst" }, `${ch.instrument}${(ch.layer ?? 0) > 0 ? ` · layer ${ch.layer}` : ""}`),
      h("span", { class: "meter-track" }, bar),
    );
    return { row, bar, nodes: program.instances[i + 1]?.outputs ?? [], layer: ch.layer ?? 0 };
  });

  const pinsNow = (): Uint8Array => pinBits(listenState.intensity, listenState.drive);
  const intensityButtons = [0, 1, 2, 3].map((v) =>
    h(
      "button",
      {
        type: "button",
        class: "seg",
        "aria-pressed": String(listenState.intensity === v),
        onclick: () => {
          listenState.intensity = v;
          intensityButtons.forEach((b, j) => b.setAttribute("aria-pressed", String(j === v)));
          applyPins();
        },
      },
      String(v),
    ),
  );
  const driveBox = h("input", {
    type: "checkbox",
    id: "drive",
    checked: listenState.drive,
    onchange: (e: Event) => {
      listenState.drive = (e.target as HTMLInputElement).checked;
      applyPins();
    },
  });
  const applyPins = (): void => {
    const pins = pinsNow();
    die.setPins(pins);
    if (player.loadedKey === key) player.setPins(pins);
    for (const m of meters) m.row.classList.toggle("off", listenState.intensity < m.layer);
  };

  const chainBox = h("div", { class: "chainbox" });
  let lastState: Uint8Array | null = null;
  renderChainBox();

  function renderChainBox(): void {
    chainBox.replaceChildren();
    if (!onChain) {
      chainBox.append(
        h("h3", null, "On X Layer"),
        h(
          "p",
          null,
          `Not taped out yet. This preview plays the same netlist the tape-out sends: ${fmt.int(cs.build.bytes.length)} bytes, with its instruments referenced at the preview processor `,
          h("code", null, fmt.addr(LOCAL_CPU)),
          ".",
        ),
        h("p", null, h("a", { href: "#/chain" }, "Check the evaluator against live X Layer circuits"), "."),
      );
      return;
    }
    const out = h("p", { class: "verify-out", role: "status" });
    const rpc = new JsonRpc();
    const proc = new Processor(rpc, onChain.processor);
    const cmpBtn = h(
      "button",
      {
        type: "button",
        class: "ghost",
        onclick: async () => {
          out.textContent = "Reading the netlist from X Layer…";
          try {
            const chain = await proc.netlist(onChain.id);
            const same = bytesToHex(chain) === cs.netlistHex;
            out.textContent = same
              ? `Identical: the ${fmt.int(chain.length)} bytes on chain are the bytes compiled here (SHA-256 ${(await sha256(chain)).slice(0, 16)}…).`
              : `Different: the chain holds ${fmt.int(chain.length)} bytes, this page compiled ${fmt.int(cs.build.bytes.length)}.`;
            out.dataset.ok = String(same);
          } catch (e) {
            out.textContent = `X Layer did not answer: ${(e as Error).message}`;
          }
        },
      },
      "Compare the netlist",
    );
    const stepBtn = h(
      "button",
      {
        type: "button",
        class: "ghost",
        onclick: async () => {
          const state = lastState ?? new Uint8Array(cs.circuit.nState);
          const pins = pinsNow();
          out.textContent = "Sending this beat's state to step() on X Layer…";
          try {
            const local = beat(cs.circuit, state, pins);
            const t0 = performance.now();
            const remote = await proc.step(onChain.id, cs.circuit.nState, cs.circuit.nOut, state, pins);
            const ms = Math.round(performance.now() - t0);
            const same =
              bytesToHex(remote.newState) === bytesToHex(local.newState) && bytesToHex(remote.outputs) === bytesToHex(local.outputs);
            out.textContent = same
              ? `Match: X Layer computed the same next state (${cs.circuit.nState} bits) and the same sample in ${ms} ms.`
              : "Mismatch between this player and X Layer.";
            out.dataset.ok = String(same);
          } catch (e) {
            out.textContent = `X Layer did not answer: ${(e as Error).message}`;
          }
        },
      },
      "Check this beat on chain",
    );
    chainBox.append(
      h("h3", null, "On X Layer"),
      h(
        "p",
        null,
        "Pressed as circuit ",
        h("strong", null, `#${onChain.id}`),
        " of processor ",
        h("code", null, fmt.addr(onChain.processor)),
        ` (block ${fmt.int(DEPLOYMENT!.block)}).`,
      ),
      h("div", { class: "row" }, cmpBtn, stepBtn),
      out,
    );
  }

  const tracklist = h(
    "ol",
    { class: "tracklist" },
    ...CATALOG.map((c) =>
      h(
        "li",
        null,
        h(
          "a",
          { href: `#/listen/${c.slug}`, "aria-current": c.slug === entry.slug ? "page" : undefined },
          h("span", { class: "side" }, c.side),
          h("span", { class: "t" }, c.song.title),
          h("span", { class: "a" }, c.song.artist),
        ),
      ),
    ),
  );

  const facts = h(
    "dl",
    { class: "facts" },
    h("div", null, h("dt", null, "Netlist on chain"), h("dd", null, fmt.int(cs.build.bytes.length), h("small", null, " bytes"))),
    h("div", null, h("dt", null, "Same song as a CD-quality WAV"), h("dd", null, fmt.bytes(wavBytes))),
    h("div", null, h("dt", null, "Smaller by"), h("dd", null, `${Math.round(wavBytes / cs.build.bytes.length)}×`)),
    h("div", null, h("dt", null, "Gates in the song"), h("dd", null, fmt.int(ownGates))),
    h("div", null, h("dt", null, "With its instruments"), h("dd", null, fmt.int(totalGates))),
    h("div", null, h("dt", null, "State"), h("dd", null, fmt.int(cs.circuit.nState), h("small", null, " LATCH bits"))),
  );

  const view = h(
    "section",
    { class: "spread" },
    h(
      "div",
      { class: "sleeve" },
      canvas,
      h(
        "div",
        { class: "sleeve-title" },
        h("span", { class: "side big" }, entry.side),
        h("h1", { class: song.title.length > 18 ? "long" : undefined }, song.title),
        h("p", null, song.artist),
      ),
    ),
    h(
      "div",
      { class: "notes" },
      tracklist,
      h("div", { class: "transport" }, playBtn, h("div", null, time, h("br"), engineNote)),
      h(
        "p",
        { class: "lede" },
        `What you hear is computed by ${fmt.int(totalGates)} NAND and LATCH gates, one beat per sample, ${fmt.int(BEAT_RATE)} beats a second. The song is a TapeOut circuit; each of its ${cs.build.refs} channels plays an instrument circuit it references.`,
      ),
      facts,
      h(
        "fieldset",
        { class: "pins" },
        h("legend", null, "Pins a game can drive"),
        h(
          "div",
          { class: "pin" },
          h("span", { id: "int-label" }, "Intensity"),
          h("div", { class: "segs", role: "group", "aria-labelledby": "int-label" }, ...intensityButtons),
        ),
        h("div", { class: "pin" }, h("label", { for: "drive" }, "Drive (faster tempo)"), driveBox),
        h("p", { class: "muted small" }, `Input pins ${PIN_NAMES.join(", ")}. A channel plays when the intensity reaches its layer.`),
      ),
      h("ul", { class: "meters", "aria-label": "Channel levels" }, ...meters.map((m) => m.row)),
      scope,
      chainBox,
      licencePanel(song, cs, onChain),
      h("p", { class: "credit" }, song.credit ?? ""),
    ),
  );
  root.replaceChildren(view);

  requestAnimationFrame(() => {
    die.setProgram(program, prep.regionOf, prep.label, pinsNow());
    applyPins();
  });

  const syncButton = (): void => {
    const mine = player.loadedKey === key && player.playing;
    playBtn.textContent = mine ? "Pause" : "Play";
    playBtn.setAttribute("aria-label", mine ? "Pause" : "Play");
    engineNote.textContent =
      player.loadedKey === key && player.engineKind
        ? player.engineKind === "compiled"
          ? "compiled to JavaScript"
          : "typed-array interpreter"
        : "";
  };
  playBtn.addEventListener("click", async () => {
    if (player.loadedKey === key && player.playing) {
      player.pause();
      return;
    }
    if (player.loadedKey !== key) await player.load(key, program, "song", 15 * song.channels.length, pinsNow());
    await player.play();
  });

  let cooling = 0;
  const offFrame = player.onFrame((f) => {
    if (player.loadedKey !== key) return;
    lastState = f.state;
    die.update(f.state);
    // The song loops back to its loop row after its last row: show the position inside the song.
    const loopAt = ((song.loopRow ?? 0) * cs.rowBeats) / BEAT_RATE;
    const raw = f.beat / BEAT_RATE;
    const s = raw < seconds ? raw : loopAt + ((raw - seconds) % Math.max(0.001, seconds - loopAt));
    time.textContent = `${fmt.secs(s)} / ${fmt.secs(seconds)}`;
    for (const m of meters) {
      const v = die.word(m.nodes);
      m.bar.style.width = `${(v / 15) * 100}%`;
    }
    drawScope(scope, f.scope);
  });
  const offChange = player.onChange(syncButton);
  syncButton();
  const coolTimer = setInterval(() => {
    if (!player.playing || player.loadedKey !== key) {
      if (cooling++ < 20) die.cool();
    } else cooling = 0;
  }, 50);
  const onResize = (): void => die.setProgram(program, prep.regionOf, prep.label, pinsNow());
  window.addEventListener("resize", onResize);
  drawScope(scope, null);
  return () => {
    offFrame();
    offChange();
    clearInterval(coolTimer);
    window.removeEventListener("resize", onResize);
  };
}
