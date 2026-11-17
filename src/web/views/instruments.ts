/**
 * Instruments: the five instrument circuits, each one playable from the computer keyboard. Every key press runs
 * through the gates of the chosen circuit, beat by beat.
 */
import { flatten, simplify } from "../../core/flat";
import { BEAT_RATE, INSTRUMENTS, INSTRUMENT_KEYS } from "../../core/instruments";
import { noiseInc, noteInc } from "../../core/song";
import { player } from "../audio";
import { library } from "../catalog";
import { DieView } from "../die";
import { drawScope } from "./listen";
import { fmt, h } from "../ui";

const KEYS = "awsedftgyhujkolp;"; // a = C, w = C#, s = D ...
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B", "C", "C#", "D", "D#", "E"];

const PINS: Array<[string, string]> = [
  ["in 0–13", "pitch: phase increment per beat"],
  ["in 14", "trig: 1 on the first beat of a note"],
  ["in 15", "gate: 1 while the note sounds"],
  ["in 16", "tick: envelope clock, 1 beat in 256"],
  ["in 17–20", "volume 0–15"],
  ["in 21–24", "tone (bits 0–1) and decay (bits 2–3)"],
  ["out 0–3", "amplitude 0–15"],
];

export function instrumentsView(root: HTMLElement): () => void {
  const lib = library();
  let current = INSTRUMENT_KEYS[0]!;
  let tone = 0;
  let decay = 2;
  let octave = 4;
  const canvas = h("canvas", { class: "die small-die", role: "img", "aria-label": "The selected instrument circuit drawn as a chip" });
  const die = new DieView(canvas);
  const scope = h("canvas", { class: "scope", "aria-hidden": "true" });
  const keyStatus = h("p", { class: "muted small", role: "status" }, "Click the keyboard or press A W S E D F T G Y H U J K.");
  const details = h("div", { class: "inst-details" });
  const keyboard = h("div", { class: "keys", role: "group", "aria-label": "Keyboard" });
  const key = (): string => `voice:${current}`;

  const programFor = (k: string) => simplify(flatten(lib.get(k).circuit));

  async function select(k: string): Promise<void> {
    current = k;
    const e = lib.get(k);
    const p = programFor(k);
    die.setProgram(p, (_i, elem) => e.build.regions[elem] ?? "logic", () => e.target.name ?? k, new Uint8Array(25));
    for (const b of list.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.key === k));
    const inst = INSTRUMENTS[k]!;
    details.replaceChildren(
      h("h2", null, inst.name),
      h("p", null, inst.summary),
      h(
        "dl",
        { class: "facts compact" },
        h("div", null, h("dt", null, "NAND"), h("dd", null, fmt.int(e.build.nand))),
        h("div", null, h("dt", null, "LATCH"), h("dd", null, fmt.int(e.build.latch))),
        h("div", null, h("dt", null, "Netlist"), h("dd", null, fmt.int(e.build.bytes.length), h("small", null, " bytes"))),
        h("div", null, h("dt", null, "Circuit"), h("dd", null, h("code", null, `${fmt.addr(e.target.cpu)} #${e.target.id}`))),
      ),
      h(
        "label",
        { class: "field" },
        h("span", null, "Tone"),
        h("select", { onchange: (ev: Event) => (tone = Number((ev.target as HTMLSelectElement).value)) }, ...inst.tones.map((t, i) => h("option", { value: String(i), selected: i === tone }, t))),
      ),
      h(
        "label",
        { class: "field" },
        h("span", null, "Decay"),
        h("select", { onchange: (ev: Event) => (decay = Number((ev.target as HTMLSelectElement).value)) }, ...["none", "slow", "medium", "fast"].map((t, i) => h("option", { value: String(i), selected: i === decay }, t))),
      ),
    );
    await player.load(key(), p, "voice", 15, new Uint8Array(0));
  }

  const list = h(
    "div",
    { class: "inst-list", role: "group", "aria-label": "Instruments" },
    ...INSTRUMENT_KEYS.map((k) => h("button", { type: "button", class: "seg", "data-key": k, "aria-pressed": "false", onclick: () => void select(k) }, INSTRUMENTS[k]!.name)),
  );

  let held = -1;
  async function noteOn(i: number): Promise<void> {
    if (player.loadedKey !== key()) await select(current);
    await player.play();
    const midi = 12 * (octave + 1) + i;
    const inc = current === "noise" ? noiseInc(midi + 36) : noteInc(midi);
    player.noteOn(inc, 13, tone | (decay << 2));
    held = i;
    const hz = current === "noise" ? "" : ` · ${(440 * 2 ** ((midi - 69) / 12)).toFixed(1)} Hz · increment ${inc} per beat`;
    keyStatus.textContent = `${NAMES[i]}${octave + Math.floor(i / 12)}${hz}`;
    for (const b of keyboard.children) b.classList.toggle("down", Number((b as HTMLElement).dataset.i) === i);
  }
  function noteOff(i?: number): void {
    if (i !== undefined && i !== held) return;
    player.noteOff();
    held = -1;
    for (const b of keyboard.children) b.classList.remove("down");
  }
  for (let i = 0; i < 13; i++) {
    const black = [1, 3, 6, 8, 10].includes(i % 12);
    const b = h("button", { type: "button", class: black ? "key black" : "key", "data-i": String(i), "aria-label": `${NAMES[i]} (key ${KEYS[i]!.toUpperCase()})` }, KEYS[i]!.toUpperCase());
    b.addEventListener("pointerdown", () => void noteOn(i));
    b.addEventListener("pointerup", () => noteOff(i));
    b.addEventListener("pointerleave", () => noteOff(i));
    keyboard.append(b);
  }
  const onKey = (e: KeyboardEvent): void => {
    if (e.repeat || (e.target as HTMLElement).closest("input,select,textarea")) return;
    const i = KEYS.indexOf(e.key.toLowerCase());
    if (e.key === "z") octave = Math.max(1, octave - 1);
    else if (e.key === "x") octave = Math.min(6, octave + 1);
    else if (i >= 0 && i < 13) {
      if (e.type === "keydown") void noteOn(i);
      else noteOff(i);
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);

  const view = h(
    "section",
    { class: "instruments" },
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Instruments"),
      h(
        "p",
        { class: "lede" },
        "Each instrument is its own TapeOut circuit with the same 25 input pins and 4 output pins, so a song can reference any of them and a maker can publish a new one that fits every song.",
      ),
    ),
    list,
    h("div", { class: "inst-grid" }, h("div", null, canvas, keyboard, keyStatus, scope), h("div", null, details, pinTable())),
  );
  root.replaceChildren(view);
  requestAnimationFrame(() => void select(current).catch(() => undefined));

  const offFrame = player.onFrame((f) => {
    if (player.loadedKey !== key()) return;
    die.update(f.state);
    drawScope(scope, f.scope);
  });
  return () => {
    offFrame();
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    noteOff();
    void BEAT_RATE;
  };
}

function pinTable(): HTMLElement {
  return h(
    "table",
    { class: "pins-table" },
    h("caption", null, "The Gatefold voice interface"),
    h("tbody", null, ...PINS.map(([a, b]) => h("tr", null, h("th", { scope: "row" }, a), h("td", null, b)))),
  );
}
