import "./style.css";
import { player } from "./audio";
import { h } from "./ui";
import { chainView } from "./views/chain";
import { howView } from "./views/how";
import { instrumentsView } from "./views/instruments";
import { listenView } from "./views/listen";
import { studioView } from "./views/studio";

const NAV: Array<[string, string]> = [
  ["#/listen", "Listen"],
  ["#/studio", "Studio"],
  ["#/instruments", "Instruments"],
  ["#/chain", "X Layer"],
  ["#/how", "Liner notes"],
];

const main = h("main", { id: "view", tabindex: "-1" });
const nav = h("nav", { "aria-label": "Sections" }, ...NAV.map(([href, label]) => h("a", { href }, label)));
const nowPlaying = h("button", { type: "button", class: "now", hidden: true, onclick: () => player.pause() }, "Pause");

document.body.append(
  h("a", { class: "skip", href: "#view" }, "Skip to content"),
  h(
    "header",
    { class: "top" },
    h("a", { class: "brand", href: "#/listen", "aria-label": "Gatefold home" }, h("span", { class: "mark", "aria-hidden": "true" }), "Gatefold"),
    nav,
    nowPlaying,
  ),
  main,
  h(
    "footer",
    { class: "foot" },
    h("p", null, "Songs pressed as chips on X Layer. Every instrument and every song is a TapeOut circuit."),
    h("p", null, h("a", { href: "https://github.com/Marc-Dvci/gatefold", rel: "noopener" }, "Source (MIT)")),
  ),
);

player.onChange(() => {
  nowPlaying.hidden = !player.playing;
});

let dispose: (() => void) | null = null;

function route(): void {
  const hash = location.hash || "#/listen";
  const [, page, arg] = hash.split("/");
  dispose?.();
  for (const a of nav.querySelectorAll("a")) a.setAttribute("aria-current", a.getAttribute("href") === `#/${page}` ? "page" : "false");
  switch (page) {
    case "studio":
      dispose = studioView(main);
      document.title = "Studio · Gatefold";
      break;
    case "instruments":
      dispose = instrumentsView(main);
      document.title = "Instruments · Gatefold";
      break;
    case "chain":
      dispose = chainView(main);
      document.title = "X Layer · Gatefold";
      break;
    case "how":
      dispose = howView(main);
      document.title = "Liner notes · Gatefold";
      break;
    default:
      dispose = listenView(main, arg);
      document.title = "Gatefold: songs pressed as chips on X Layer";
  }
  window.scrollTo(0, 0);
}

window.addEventListener("hashchange", route);
route();
