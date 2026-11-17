/**
 * Play: a small game that drives a song circuit's pins, the way a DeWEB game would with the Gatefold embed.
 * The score raises the intensity (more channels join), and boss waves switch on the drive pin (the faster tempo).
 */
import { GatefoldPlayer } from "../../embed";
import { player } from "../audio";
import { CATALOG, prepare, songOnChain } from "../catalog";
import { h } from "../ui";

const SLUG = "mountain-king";

interface Block {
  x: number;
  y: number;
  w: number;
  v: number;
}

export function intensityFor(score: number): number {
  return score < 8 ? 0 : score < 20 ? 1 : score < 35 ? 2 : 3;
}

export function playView(root: HTMLElement): () => void {
  const entry = CATALOG.find((c) => c.slug === SLUG)!;
  const canvas = h("canvas", {
    class: "game",
    width: 960,
    height: 540,
    tabindex: "0",
    role: "img",
    "aria-label": "Game field: move left and right to dodge the falling blocks",
  });
  const hud = h("p", { class: "hud", role: "status", "aria-live": "polite" });
  const start = h("button", { type: "button", class: "primary" }, "Start");
  const watch = h("button", { type: "button", class: "ghost" }, "Watch it play itself");
  let autopilot = false;
  const source = h("p", { class: "muted small" });
  let song: GatefoldPlayer | null = null;
  let running = false;
  let raf = 0;
  let last = 0;
  let px = 480;
  let score = 0;
  let blocks: Block[] = [];
  let spawn = 0;
  let bossUntil = 0;
  let nextBoss = 40;
  let t = 0;
  const keys = new Set<string>();
  let pointerX: number | null = null;

  async function ensureSong(): Promise<GatefoldPlayer> {
    if (song) return song;
    const onChain = songOnChain(SLUG);
    if (onChain) {
      song = await GatefoldPlayer.fromChain(onChain.processor, onChain.id);
      source.textContent = `Music: circuit #${onChain.id} read from X Layer (${song.info.gates} gates).`;
    } else {
      song = GatefoldPlayer.fromCircuit(prepare(entry.song).cs.circuit);
      source.textContent = `Music: "${entry.song.title}" compiled in this page (${song.info.gates} gates), the same netlist a tape-out stores.`;
    }
    return song;
  }

  function reset(): void {
    px = 480;
    score = 0;
    blocks = [];
    spawn = 0;
    bossUntil = 0;
    nextBoss = 40;
    t = 0;
  }

  /** The attract mode's pilot: steer toward the column with the least danger close above the player. */
  function pilot(): number {
    let best = px;
    let bestScore = Infinity;
    for (let x = 20; x <= 940; x += 20) {
      let danger = 0;
      for (const b of blocks) {
        if (b.y < 160 || b.y > 520) continue;
        if (x + 34 > b.x && x - 34 < b.x + b.w) danger += (b.y / 520) ** 3;
      }
      const cost = danger * 100 + Math.abs(x - px) / 300;
      if (cost < bestScore) {
        bestScore = cost;
        best = x;
      }
    }
    return best;
  }

  async function begin(auto = false): Promise<void> {
    autopilot = auto;
    player.pause();
    const s = await ensureSong();
    reset();
    s.restart();
    s.setIntensity(0);
    s.setDrive(false);
    await s.play();
    running = true;
    start.textContent = "Restart";
    canvas.focus({ preventScroll: true });
    last = performance.now();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
  }

  function over(): void {
    running = false;
    song?.setIntensity(0);
    song?.setDrive(false);
    hud.textContent = `Caught at ${score}. Press Restart or Space.`;
  }

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (running) step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function step(dt: number): void {
    t += dt;
    const boss = t < bossUntil;
    const speed = 160 + score * 6 + (boss ? 160 : 0);
    const dir = (keys.has("ArrowRight") || keys.has("d") ? 1 : 0) - (keys.has("ArrowLeft") || keys.has("a") ? 1 : 0);
    const target = autopilot ? pilot() : pointerX;
    if (target !== null) px += Math.max(-1, Math.min(1, (target - px) / 30)) * 520 * dt;
    else px += dir * 520 * dt;
    px = Math.max(20, Math.min(940, px));
    spawn -= dt;
    if (spawn <= 0) {
      const w = 40 + Math.random() * 80;
      blocks.push({ x: Math.random() * (960 - w), y: -40, w, v: speed * (0.8 + Math.random() * 0.5) });
      spawn = Math.max(0.18, (boss ? 0.32 : 0.75) - score * 0.008);
    }
    for (const b of blocks) b.y += b.v * dt;
    const before = blocks.length;
    blocks = blocks.filter((b) => b.y < 560);
    score += before - blocks.length;
    for (const b of blocks) if (b.y + 28 > 490 && b.y < 518 && px + 16 > b.x && px - 16 < b.x + b.w) return over();
    if (score >= nextBoss && !boss) {
      bossUntil = t + 12;
      nextBoss += 40;
    }
    const level = intensityFor(score);
    song?.setIntensity(level);
    song?.setDrive(t < bossUntil);
    hud.textContent = `${autopilot ? "Autopilot · " : ""}Score ${score} · intensity pin ${level} · drive pin ${t < bossUntil ? "on (boss)" : "off"}`;
  }

  function draw(): void {
    const ctx = canvas.getContext("2d")!;
    const boss = running && t < bossUntil;
    ctx.fillStyle = boss ? "#1a0a10" : "#07090d";
    ctx.fillRect(0, 0, 960, 540);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    for (let x = 0; x < 960; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, 540);
      ctx.stroke();
    }
    for (const b of blocks) {
      ctx.fillStyle = boss ? "#f06292" : "#34d1bf";
      ctx.fillRect(b.x, b.y, b.w, 28);
    }
    ctx.fillStyle = "#f2c14e";
    ctx.fillRect(px - 16, 490, 32, 28);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.font = "800 28px 'Big Shoulders Display', system-ui";
    ctx.fillText(`SCORE ${score}`, 20, 40);
    const level = intensityFor(score);
    ctx.font = "600 14px 'Inter Tight', system-ui";
    ctx.fillText(`INTENSITY ${level}   DRIVE ${boss ? "ON" : "OFF"}`, 20, 64);
    if (boss) {
      ctx.font = "800 54px 'Big Shoulders Display', system-ui";
      ctx.fillStyle = "#f06292";
      ctx.fillText("BOSS WAVE", 360, 280);
    }
    if (!running) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, 960, 540);
      ctx.fillStyle = "#eef0f5";
      ctx.font = "800 44px 'Big Shoulders Display', system-ui";
      ctx.fillText(score ? "CAUGHT" : "HALL RUN", 400, 250);
      ctx.font = "600 16px 'Inter Tight', system-ui";
      ctx.fillText("Arrow keys or A / D, or drag. Dodge the blocks.", 330, 290);
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.type === "keydown") {
      if (e.key === " " && !running && document.activeElement === canvas) {
        e.preventDefault();
        void begin(false);
      }
      keys.add(e.key.length === 1 ? e.key.toLowerCase() : e.key);
    } else keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key);
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKey);
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons || e.pointerType === "touch") pointerX = ((e.offsetX / canvas.clientWidth) * 960) | 0;
  });
  canvas.addEventListener("pointerup", () => (pointerX = null));
  canvas.addEventListener("pointerleave", () => (pointerX = null));
  start.addEventListener("click", () => void begin(false));
  watch.addEventListener("click", () => void begin(true));

  root.replaceChildren(
    h(
      "section",
      { class: "playpage" },
      h(
        "header",
        { class: "page-head" },
        h("h1", null, "Hall Run"),
        h(
          "p",
          { class: "lede" },
          "A game sets the pins of a song circuit while it plays. Your score raises the intensity pin, and each new channel joins as its layer is reached. Every 40 points a boss wave switches on the drive pin, and the tempo jumps from 116 to 168 BPM.",
        ),
        h("div", { class: "row" }, start, watch, hud),
      ),
      canvas,
      source,
      h("h2", null, "Put a song in your game"),
      h(
        "pre",
        { class: "code" },
        h(
          "code",
          null,
          `import { GatefoldPlayer } from "./gatefold.js";

const song = await GatefoldPlayer.fromChain(processor, circuitId);
await song.play();
song.setIntensity(2);  // 0-3: channels join as their layer is reached
song.setDrive(true);   // the song's faster tempo`,
        ),
      ),
      h(
        "p",
        { class: "muted small" },
        "gatefold.js and its worklet are files of your own site, so a DeWEB game keeps playing from chain bytes with no request outside rpc.xlayer.tech.",
      ),
    ),
  );
  draw();
  hud.textContent = "Press Start.";
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKey);
    song?.pause();
  };
}
