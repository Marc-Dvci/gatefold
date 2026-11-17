/**
 * Studio: write a song in MML, hear the circuit play it as you type, and tape it out on X Layer.
 */
import { JsonRpc, XLAYER } from "../../chain/rpc";
import {
  type Eip1193,
  LATCH_ID,
  NAND_ID,
  type Pricing,
  approveData,
  connectWallet,
  injectedWallet,
  mintCost,
  mintData,
  mintedId,
  pricing,
  sendTx,
  tapeoutData,
  waitReceipt,
} from "../../chain/tapeout";
import { BEAT_RATE, INSTRUMENTS, INSTRUMENT_KEYS } from "../../core/instruments";
import { parseMml } from "../../core/mml";
import { FULL, renderBeats, toPcm16, wav } from "../../core/render";
import { type ChannelSpec, type Song, SongError } from "../../core/song";
import { player } from "../audio";
import { CATALOG, type Prepared, pinBits, prepare } from "../catalog";
import { DEPLOYMENT } from "../../deployments";
import { download, fmt, h } from "../ui";

const DRAFT_KEY = "gatefold.studio.draft";

const COLORS = ["#f2c14e", "#34d1bf", "#8c7cf0", "#f06292", "#d9824b", "#7bd88f", "#56a0ff", "#e0e0e0"];

function loadDraft(): Song {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) return JSON.parse(raw) as Song;
  } catch {
    /* storage unavailable: start from the first song */
  }
  return structuredClone(CATALOG[0]!.song);
}

function saveDraft(s: Song): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: the draft lives for this visit only */
  }
}

function drawRoll(canvas: HTMLCanvasElement, song: Song): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const d = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = canvas.clientWidth || 600;
  const hh = canvas.clientHeight || 180;
  canvas.width = w * d;
  canvas.height = hh * d;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  ctx.fillStyle = "#07090d";
  ctx.fillRect(0, 0, w, hh);
  const parts = song.channels.map((c) => {
    try {
      return parseMml(c.mml, song.rowsPerBeat);
    } catch {
      return { notes: [], rows: 0 };
    }
  });
  const rows = Math.max(1, ...parts.map((p) => p.rows));
  const all = parts.flatMap((p) => p.notes.map((n) => n.midi));
  const lo = Math.min(...all, 40) - 1;
  const hi = Math.max(...all, 80) + 1;
  const bar = song.rowsPerBeat * 4;
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  for (let r = 0; r <= rows; r += bar) {
    const x = (r / rows) * w;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, hh);
    ctx.stroke();
  }
  parts.forEach((p, c) => {
    ctx.fillStyle = COLORS[c % COLORS.length]!;
    for (const n of p.notes) {
      const x = (n.row / rows) * w;
      const y = hh - ((n.midi - lo) / (hi - lo)) * hh;
      ctx.globalAlpha = 0.35 + (0.65 * n.vol) / 15;
      ctx.fillRect(x, y - 2, Math.max(1.5, (n.rows / rows) * w - 1), 3);
    }
  });
  ctx.globalAlpha = 1;
}

export function studioView(root: HTMLElement): () => void {
  let song = loadDraft();
  let prep: Prepared | null = null;
  let error: SongError | Error | null = null;
  const key = (): string => `studio:${prep?.key ?? ""}`;

  const status = h("p", { class: "compile-status", role: "status", "aria-live": "polite" });
  const stats = h("dl", { class: "facts compact" });
  const roll = h("canvas", { class: "roll", role: "img", "aria-label": "Piano roll of every channel" });
  const channelsBox = h("div", { class: "channels" });
  const playBtn = h("button", { type: "button", class: "play small" }, "Play");

  const field = (label: string, input: HTMLElement): HTMLElement => h("label", { class: "field" }, h("span", null, label), input);
  const num = (value: number, min: number, max: number, on: (v: number) => void): HTMLInputElement =>
    h("input", {
      type: "number",
      value: String(value),
      min: String(min),
      max: String(max),
      onchange: (e: Event) => on(Number((e.target as HTMLInputElement).value)),
    });

  const header = h("div", { class: "song-fields" });
  function renderHeader(): void {
    header.replaceChildren(
      field(
        "Title",
        h("input", {
          type: "text",
          value: song.title,
          maxLength: 60,
          oninput: (e: Event) => ((song.title = (e.target as HTMLInputElement).value), changed(false)),
        }),
      ),
      field(
        "Artist",
        h("input", {
          type: "text",
          value: song.artist,
          maxLength: 60,
          oninput: (e: Event) => ((song.artist = (e.target as HTMLInputElement).value), changed(false)),
        }),
      ),
      field(
        "Tempo (BPM)",
        num(song.bpm, 30, 300, (v) => ((song.bpm = v), changed())),
      ),
      field(
        "Drive tempo",
        num(song.driveBpm ?? song.bpm, 30, 300, (v) => ((song.driveBpm = v), changed())),
      ),
      field(
        "Rows per beat",
        h(
          "select",
          { onchange: (e: Event) => ((song.rowsPerBeat = Number((e.target as HTMLSelectElement).value)), changed()) },
          ...[2, 3, 4, 6, 8, 12].map((v) => h("option", { value: String(v), selected: v === song.rowsPerBeat }, String(v))),
        ),
      ),
    );
  }

  function renderChannels(): void {
    channelsBox.replaceChildren(
      ...song.channels.map((ch, i) => {
        const inst = INSTRUMENTS[ch.instrument]!;
        const set = <K extends keyof ChannelSpec>(k: K, v: ChannelSpec[K], rerender = false): void => {
          ch[k] = v;
          if (rerender) renderChannels();
          changed();
        };
        const sel = (label: string, value: number, options: string[], on: (v: number) => void): HTMLElement =>
          field(
            label,
            h(
              "select",
              { onchange: (e: Event) => on(Number((e.target as HTMLSelectElement).value)) },
              ...options.map((o, j) => h("option", { value: String(j), selected: j === value }, o)),
            ),
          );
        const ta = h("textarea", {
          spellcheck: false,
          rows: 3,
          value: ch.mml,
          "aria-label": `${ch.name} notes in MML`,
          oninput: (e: Event) => set("mml", (e.target as HTMLTextAreaElement).value),
        });
        return h(
          "section",
          { class: "channel", style: `--ch:${COLORS[i % COLORS.length]}` },
          h(
            "div",
            { class: "channel-head" },
            field(
              "Name",
              h("input", {
                type: "text",
                value: ch.name,
                maxLength: 16,
                onchange: (e: Event) => set("name", (e.target as HTMLInputElement).value),
              }),
            ),
            field(
              "Instrument",
              h(
                "select",
                { onchange: (e: Event) => set("instrument", (e.target as HTMLSelectElement).value, true) },
                ...INSTRUMENT_KEYS.map((k) => h("option", { value: k, selected: k === ch.instrument }, INSTRUMENTS[k]!.name)),
              ),
            ),
            sel("Tone", ch.tone ?? 0, inst.tones, (v) => set("tone", v)),
            sel("Decay", ch.decay ?? 0, ["none", "slow", "medium", "fast"], (v) => set("decay", v)),
            sel("Layer", ch.layer ?? 0, ["0 (always)", "1", "2", "3"], (v) => set("layer", v)),
            field(
              "Release",
              h("input", {
                type: "range",
                min: "0.1",
                max: "1",
                step: "0.05",
                value: String(ch.release ?? 1),
                "aria-label": `${ch.name} release`,
                onchange: (e: Event) => set("release", Number((e.target as HTMLInputElement).value)),
              }),
            ),
            h(
              "button",
              {
                type: "button",
                class: "icon",
                "aria-label": `Remove ${ch.name}`,
                disabled: song.channels.length <= 1,
                onclick: () => {
                  song.channels.splice(i, 1);
                  renderChannels();
                  changed();
                },
              },
              "×",
            ),
          ),
          ta,
          error instanceof SongError && error.channel === i ? h("p", { class: "error" }, error.message) : null,
        );
      }),
      h(
        "button",
        {
          type: "button",
          class: "ghost",
          disabled: song.channels.length >= 8,
          onclick: () => {
            song.channels.push({
              name: `ch${song.channels.length + 1}`,
              instrument: "pulse",
              tone: 2,
              decay: 1,
              mml: "o4 l8 v10 c e g > c",
            });
            renderChannels();
            changed();
          },
        },
        "Add a channel",
      ),
    );
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  function changed(recompile = true): void {
    saveDraft(song);
    if (!recompile) return;
    clearTimeout(timer);
    timer = setTimeout(compile, 200);
  }

  function compile(): void {
    const t0 = performance.now();
    const before = error;
    try {
      prep = prepare(structuredClone(song));
      error = null;
      const cs = prep.cs;
      const ms = performance.now() - t0;
      status.textContent = `Compiled in ${ms.toFixed(0)} ms: ${fmt.int(cs.build.nand)} NAND, ${fmt.int(cs.build.latch)} LATCH, ${cs.build.refs} REF, ${fmt.int(cs.build.bytes.length)} bytes.`;
      status.dataset.ok = "true";
      stats.replaceChildren(
        h("div", null, h("dt", null, "Length"), h("dd", null, fmt.secs(cs.beats / BEAT_RATE), h("small", null, ` · ${cs.rows} rows`))),
        h("div", null, h("dt", null, "Netlist"), h("dd", null, fmt.int(cs.build.bytes.length), h("small", null, " bytes"))),
        h(
          "div",
          null,
          h("dt", null, "Transistors to burn"),
          h("dd", null, fmt.int(cs.build.nand + cs.build.latch), h("small", null, ` (${cs.build.nand} NAND, ${cs.build.latch} LATCH)`)),
        ),
        h("div", null, h("dt", null, "With instruments"), h("dd", null, fmt.int(cs.circuit.nGates), h("small", null, " gates"))),
      );
      if (player.playing && player.loadedKey.startsWith("studio:")) void play(true);
    } catch (e) {
      error = e as Error;
      status.textContent = (e as Error).message;
      status.dataset.ok = "false";
    }
    if (Boolean(before) !== Boolean(error) || error instanceof SongError) renderChannels();
    drawRoll(roll, song);
    renderTapeout();
  }

  async function play(restart = false): Promise<void> {
    if (!prep) return;
    if (player.loadedKey !== key() || restart) await player.load(key(), prep.program, "song", 15 * song.channels.length, pinBits(3, false));
    await player.play();
  }
  playBtn.addEventListener("click", async () => {
    if (player.playing && player.loadedKey.startsWith("studio:")) player.pause();
    else await play();
  });

  const loadSelect = h(
    "select",
    {
      "aria-label": "Start from a song",
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        const c = CATALOG.find((x) => x.slug === v);
        if (!c) return;
        song = structuredClone(c.song);
        renderHeader();
        renderChannels();
        changed();
      },
    },
    h("option", { value: "" }, "Start from…"),
    ...CATALOG.map((c) => h("option", { value: c.slug }, `${c.side} ${c.song.title}`)),
  );

  const exportRow = h(
    "div",
    { class: "row" },
    playBtn,
    h(
      "button",
      {
        type: "button",
        class: "ghost",
        onclick: () => {
          if (!prep) return;
          const raw = renderBeats(prep.cs, prep.cs.beats, FULL);
          download(
            `${song.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "song"}.wav`,
            wav(toPcm16(raw, song.channels.length)),
            "audio/wav",
          );
        },
      },
      "Download WAV",
    ),
    h(
      "button",
      {
        type: "button",
        class: "ghost",
        onclick: () => {
          if (!prep) return;
          const cs = prep.cs;
          download(
            `${song.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "song"}.netlist.json`,
            JSON.stringify(
              {
                format: "tap-02",
                nIn: cs.build.nIn,
                nOut: cs.build.nOut,
                nand: cs.build.nand,
                latch: cs.build.latch,
                refs: cs.build.refs,
                netlist: cs.netlistHex,
                song,
              },
              null,
              2,
            ),
            "application/json",
          );
        },
      },
      "Download netlist",
    ),
  );

  // Tape-out panel.
  const tapeBox = h("section", { class: "tapeout", "aria-labelledby": "tape-h" });
  let wallet: Eip1193 | null = null;
  let account = "";
  let price: Pricing | null = null;
  const log = h("ol", { class: "txlog" });
  const say = (text: string, ok?: boolean): void => {
    const li = h("li", null, text);
    if (ok !== undefined) li.dataset.ok = String(ok);
    log.append(li);
  };

  function renderTapeout(): void {
    const cs = prep?.cs;
    const needN = BigInt(cs?.build.nand ?? 0);
    const needL = BigInt(cs?.build.latch ?? 0);
    const ready = Boolean(DEPLOYMENT && cs);
    const connectBtn = h(
      "button",
      {
        type: "button",
        class: "ghost",
        onclick: async () => {
          wallet = injectedWallet();
          if (!wallet) {
            say("No wallet found in this browser. Install OKX Wallet or another EIP-1193 wallet.", false);
            return;
          }
          try {
            account = await connectWallet(wallet);
            say(`Connected ${fmt.addr(account)} on X Layer.`, true);
            if (DEPLOYMENT) price = await pricing(new JsonRpc(), DEPLOYMENT.processor, account);
            renderTapeout();
          } catch (e) {
            say(`Wallet: ${(e as Error).message}`, false);
          }
        },
      },
      account ? `Connected ${fmt.addr(account)}` : "Connect wallet",
    );
    const missingN = price && price.nand < needN ? needN - price.nand : 0n;
    const missingL = price && price.latch < needL ? needL - price.latch : 0n;
    const mintBtn = h(
      "button",
      {
        type: "button",
        class: "ghost",
        disabled: !price || (missingN === 0n && missingL === 0n),
        onclick: async () => {
          if (!wallet || !price) return;
          const rpc = new JsonRpc();
          try {
            if (price.payToken) {
              const total = mintCost(price, missingN) + mintCost(price, missingL);
              say(`Approving ${total} BEM base units for the transistor contract…`);
              await waitReceipt(rpc, await sendTx(wallet, account, price.payToken, approveData(price.transistors, total)));
            }
            for (const [id, amt] of [
              [NAND_ID, missingN],
              [LATCH_ID, missingL],
            ] as const) {
              if (amt === 0n) continue;
              const value = price.payToken ? 0n : mintCost(price, amt);
              say(`Minting ${amt} ${id === NAND_ID ? "NAND" : "LATCH"} transistors…`);
              await waitReceipt(rpc, await sendTx(wallet, account, price.transistors, mintData(id, amt), value));
            }
            price = await pricing(rpc, DEPLOYMENT!.processor, account);
            say("Transistors minted.", true);
            renderTapeout();
          } catch (e) {
            say(`Mint: ${(e as Error).message}`, false);
          }
        },
      },
      "Mint the missing transistors",
    );
    const tapeBtn = h(
      "button",
      {
        type: "button",
        class: "primary",
        disabled: !price || !cs || missingN > 0n || missingL > 0n,
        onclick: async () => {
          if (!wallet || !price || !cs) return;
          const rpc = new JsonRpc();
          try {
            say(`Taping out ${fmt.int(cs.build.bytes.length)} bytes (fee ${fmt.okb(price.tapeoutFee)})…`);
            const hash = await sendTx(
              wallet,
              account,
              DEPLOYMENT!.processor,
              tapeoutData(cs.build.bytes, cs.build.nIn, cs.build.nOut),
              price.tapeoutFee,
            );
            const r = await waitReceipt(rpc, hash);
            const id = mintedId(r, DEPLOYMENT!.processor, account);
            say(`Pressed: circuit #${id} on processor ${fmt.addr(DEPLOYMENT!.processor)}, gas ${fmt.int(BigInt(r.gasUsed))}.`, true);
            log.append(
              h("li", null, h("a", { href: `${XLAYER.explorer}/tx/${hash}`, target: "_blank", rel: "noopener" }, "Open the transaction")),
            );
          } catch (e) {
            say(`Tape-out: ${(e as Error).message}`, false);
          }
        },
      },
      "Tape out on X Layer",
    );
    tapeBox.replaceChildren(
      h("h2", { id: "tape-h" }, "Tape out"),
      ready
        ? h(
            "p",
            null,
            `A tape-out stores this netlist on the Gatefold processor and mints it to you as a circuit NFT. It burns ${fmt.int(needN)} NAND and ${fmt.int(needL)} LATCH transistors; the instruments it references are not burned again.`,
          )
        : h(
            "p",
            null,
            "Taping out opens once the Gatefold instrument circuits are on X Layer. Until then the studio compiles and plays the exact netlist a tape-out would send, with its instruments at the preview processor.",
          ),
      ...(price
        ? [
            h(
              "p",
              { class: "muted small" },
              `You hold ${price.nand} NAND and ${price.latch} LATCH. Transistors cost ${price.mintPrice} ${price.payToken ? "BEM base units" : "wei"} each, plus ${price.protocolFee} per mint; the tape-out fee is ${fmt.okb(price.tapeoutFee)}.`,
            ),
          ]
        : []),
      h("div", { class: "row" }, connectBtn, mintBtn, tapeBtn),
      log,
    );
    if (!ready) for (const b of tapeBox.querySelectorAll("button")) (b as HTMLButtonElement).disabled = true;
  }

  const view = h(
    "section",
    { class: "studio" },
    h(
      "header",
      { class: "page-head" },
      h("h1", null, "Studio"),
      h(
        "p",
        { class: "lede" },
        "Write each channel in MML, the notation chiptune composers have typed since the 1980s. Every change recompiles the song into gates and plays the new circuit.",
      ),
      loadSelect,
    ),
    header,
    h(
      "div",
      { class: "studio-grid" },
      channelsBox,
      h("aside", { class: "studio-side" }, status, stats, roll, exportRow, tapeBox, mmlHelp()),
    ),
  );
  root.replaceChildren(view);
  renderHeader();
  renderChannels();
  compile();
  const off = player.onChange(() => {
    playBtn.textContent = player.playing && player.loadedKey.startsWith("studio:") ? "Pause" : "Play";
  });
  return () => {
    off();
    clearTimeout(timer);
  };
}

function mmlHelp(): HTMLElement {
  const rows: Array<[string, string]> = [
    ["c d e f g a b", "notes; + or # sharp, - flat; then a length: 4 quarter, 8 eighth, 16…, dots extend"],
    ["r", "rest"],
    ["o4  <  >", "octave; one down; one up"],
    ["l8", "default length"],
    ["v12", "volume 0–15"],
    ["@2  @d3", "tone 0–3; decay 0–3"],
    ["n60,4", "a note by MIDI number"],
    ["&", "tie into the next note"],
    ["[ … ]4", "repeat four times"],
  ];
  return h(
    "details",
    { class: "mml-help" },
    h("summary", null, "MML in one minute"),
    h(
      "table",
      null,
      h("tbody", null, ...rows.map(([a, b]) => h("tr", null, h("th", { scope: "row" }, h("code", null, a)), h("td", null, b)))),
    ),
  );
}
