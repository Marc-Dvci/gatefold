/**
 * License this song: the price, the split of one payment along the song's REF lineage, and the licence itself, paid
 * in USD₮0 with one signature from the visitor's wallet. Payees see what Gatefold Records owes them and withdraw it.
 */
import {
  type Credit,
  type Lineage,
  MAX_PARENTS,
  TERMS,
  buyLicence,
  chainLineage,
  readFeeBps,
  readLicensed,
  readOwed,
  readOwner,
  readRelease,
  readUsdt0,
  refTargets,
  releaseKey,
  splitLicence,
  usdt0,
  withdrawData,
} from "../../chain/records";
import { JsonRpc, XLAYER } from "../../chain/rpc";
import { type Eip1193, connectWallet, injectedWallet, sendTx, waitReceipt } from "../../chain/tapeout";
import { INSTRUMENTS } from "../../core/instruments";
import type { CompiledSong, Song } from "../../core/song";
import { refKey } from "../../core/tap02";
import { DEPLOYMENT } from "../../deployments";
import { library } from "../catalog";
import { fmt, h } from "../ui";

const SWATCH = ["#34d1bf", "#8c7cf0", "#f06292", "#ff9f5a", "#5fa8ff", "#c6e06b", "#e48df0", "#7fe0d2"];
const FEE_SWATCH = "#5b6377";
const OWNER_SWATCH = "#f2c14e";

/** The instruments a song references, by release key, named after the channels that play them. */
function instrumentLabels(song: Song, cs: CompiledSong): Map<string, { label: string; id: bigint }> {
  const lib = library();
  const byRef = new Map<string, string>();
  for (const e of lib.entries.values()) byRef.set(refKey(e.target.cpu, e.target.id), e.key);
  const out = new Map<string, { label: string; id: bigint }>();
  for (const r of refTargets(cs.build.bytes, cs.build.nIn)) {
    const inst = byRef.get(refKey(r.cpu, r.id));
    const key = releaseKey(r.cpu, r.id);
    if (!inst || out.has(key) || out.size >= MAX_PARENTS) continue;
    const players = song.channels.filter((c) => c.instrument === inst).map((c) => c.name);
    out.set(key, { label: `${INSTRUMENTS[inst]?.name ?? inst} instrument · ${players.join(", ")}`, id: r.id });
  }
  return out;
}

export function licencePanel(song: Song, cs: CompiledSong, onChain: { processor: string; id: bigint } | null): HTMLElement {
  const box = h("section", { class: "licence", "aria-labelledby": "lic-h" });
  const instruments = instrumentLabels(song, cs);
  const records = DEPLOYMENT?.records ?? null;
  const live = Boolean(onChain && records);
  const songKey = onChain ? releaseKey(onChain.processor, onChain.id) : "song";
  const ownerLabel = "Song owner";
  const labelOf = (k: string): string => (k === songKey ? ownerLabel : (instruments.get(k)?.label ?? fmt.addr(k)));

  // The terms the page shows before reading the chain: the deploy script's release terms over the song's REF records.
  let price: bigint = TERMS.songPrice;
  let feeBps: number = TERMS.feeBps;
  let lineage: Lineage = {
    key: songKey,
    label: ownerLabel,
    upstreamBps: TERMS.songUpstreamBps,
    parents: [...instruments.entries()].map(([key, v]) => ({ key, label: v.label, upstreamBps: 0, parents: [] })),
  };
  const holders = new Map<string, string>();
  let fromChain = false;

  let wallet: Eip1193 | null = null;
  let account = "";
  let owed = 0n;
  let balance: bigint | null = null;
  const log = h("ol", { class: "txlog" });
  const say = (text: string, ok?: boolean): HTMLLIElement => {
    const li = h("li", null, text);
    if (ok !== undefined) li.dataset.ok = String(ok);
    log.append(li);
    return li;
  };
  const licensee = h("input", {
    type: "text",
    id: "licensee",
    class: "mono",
    spellcheck: false,
    autocomplete: "off",
    placeholder: "0x… (your wallet when empty)",
  });

  function render(): void {
    const credits: Credit[] = splitLicence(price, feeBps, lineage);
    const swatch = (c: Credit, i: number): string =>
      c.key === "fee" ? FEE_SWATCH : c.key === songKey ? OWNER_SWATCH : SWATCH[i % SWATCH.length]!;
    const pct = (a: bigint): string =>
      `${(Number((a * 100_000n) / (price || 1n)) / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })} %`;
    const bar = h(
      "div",
      { class: "split-bar", role: "img", "aria-label": credits.map((c) => `${c.label}: ${usdt0(c.amount)} USD₮0`).join("; ") },
      ...credits.map((c, i) => h("span", { style: `flex-grow:${Number(c.amount)};background:${swatch(c, i)}` })),
    );
    const rows = credits.map((c, i) =>
      h(
        "tr",
        null,
        h("td", null, h("span", { class: "swatch", style: `background:${swatch(c, i)}` })),
        h(
          "th",
          { scope: "row" },
          c.key === "fee" ? `Gatefold fee · ${feeBps / 100} %` : c.label,
          holders.get(c.key) ? h("span", { class: "muted small mono" }, ` ${fmt.addr(holders.get(c.key)!)}`) : null,
        ),
        h("td", { class: "num" }, pct(c.amount)),
        h("td", { class: "num" }, usdt0(c.amount)),
      ),
    );
    const connectBtn = h(
      "button",
      { type: "button", class: "ghost", disabled: !live, onclick: connect },
      account ? `Connected ${fmt.addr(account)}` : "Connect wallet",
    );
    const buyBtn = h(
      "button",
      { type: "button", class: "primary", disabled: !live || !account, onclick: buy },
      `License for ${usdt0(price)} USD₮0`,
    );
    const withdrawBtn = h(
      "button",
      { type: "button", class: "ghost", disabled: !live || owed === 0n, onclick: withdraw },
      owed > 0n ? `Withdraw ${usdt0(owed)} USD₮0` : "Withdraw",
    );
    box.replaceChildren(
      h("h3", { id: "lic-h" }, "License this song"),
      h(
        "p",
        null,
        `A game or a site licenses “${song.title}” for `,
        h("strong", null, `${usdt0(price)} USD₮0`),
        ", paid with one signature. Gatefold Records splits each payment on X Layer along the song's REF lineage, so the makers of the instruments it plays are paid with its owner.",
      ),
      bar,
      h(
        "table",
        { class: "split" },
        h("caption", { class: "muted small" }, `Who is paid from one licence; amounts in USD₮0`),
        h("tbody", null, ...rows),
      ),
      fromChain
        ? h(
            "p",
            { class: "muted small" },
            `Read from Gatefold Records at ${fmt.addr(records!)}: the price, the fee, the ${lineage.upstreamBps / 100} % upstream share and the parents it recorded from the song's REF records.`,
          )
        : h(
            "p",
            { class: "muted small" },
            `Computed here from the song's ${instruments.size} REF records and its release terms (${TERMS.songUpstreamBps / 100} % upstream), exactly as Gatefold Records computes it on X Layer.${live ? "" : " Licences open with the song's release there."}`,
          ),
      h("label", { for: "licensee", class: "small" }, "Licensee: the game, site or wallet the licence is for"),
      licensee,
      h("div", { class: "row" }, connectBtn, buyBtn, withdrawBtn),
      ...(account && balance !== null
        ? [h("p", { class: "muted small" }, `This wallet holds ${usdt0(balance)} USD₮0; Gatefold Records owes it ${usdt0(owed)} USD₮0.`)]
        : []),
      log,
    );
  }

  async function refreshWallet(rpc: JsonRpc): Promise<void> {
    [balance, owed] = await Promise.all([readUsdt0(rpc, account), readOwed(rpc, records!, account)]);
  }

  async function connect(): Promise<void> {
    wallet = injectedWallet();
    if (!wallet) {
      say("No wallet found in this browser. Install OKX Wallet or another EIP-1193 wallet.", false);
      return;
    }
    try {
      account = await connectWallet(wallet);
      await refreshWallet(new JsonRpc());
      render();
      say(`Connected ${fmt.addr(account)} on X Layer.`, true);
    } catch (e) {
      say(`Wallet: ${(e as Error).message}`, false);
    }
  }

  async function buy(): Promise<void> {
    if (!wallet || !onChain || !records) return;
    const who = (licensee.value.trim() || account).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(who)) {
      say("The licensee must be an address: 0x and 40 hexadecimal digits.", false);
      return;
    }
    const rpc = new JsonRpc();
    try {
      if (await readLicensed(rpc, records, onChain.processor, onChain.id, who)) {
        say(`${fmt.addr(who)} already holds a licence for “${song.title}”.`, true);
        return;
      }
      if (balance !== null && balance < price) {
        say(`This wallet holds ${usdt0(balance)} USD₮0; the licence is ${usdt0(price)} USD₮0.`, false);
        return;
      }
      say(`Sign the ${usdt0(price)} USD₮0 authorization in your wallet, then send it to Gatefold Records…`);
      const hash = await buyLicence(wallet, {
        account,
        records,
        cpu: onChain.processor,
        id: onChain.id,
        licensee: who,
        price,
        now: BigInt(Math.floor(Date.now() / 1000)),
      });
      await waitReceipt(rpc, hash);
      const ok = await readLicensed(rpc, records, onChain.processor, onChain.id, who);
      say(
        ok
          ? `Licensed: ${fmt.addr(who)} holds a licence for “${song.title}”, and the payment is credited along its lineage.`
          : "The licence is not recorded.",
        ok,
      );
      log.append(
        h("li", null, h("a", { href: `${XLAYER.explorer}/tx/${hash}`, target: "_blank", rel: "noopener" }, "Open the transaction")),
      );
      await refreshWallet(rpc);
      render();
    } catch (e) {
      say(`Licence: ${(e as Error).message}`, false);
    }
  }

  async function withdraw(): Promise<void> {
    if (!wallet || !records) return;
    const rpc = new JsonRpc();
    try {
      say(`Withdrawing ${usdt0(owed)} USD₮0…`);
      await waitReceipt(rpc, await sendTx(wallet, account, records, withdrawData()));
      say("Withdrawn to this wallet.", true);
      await refreshWallet(rpc);
      render();
    } catch (e) {
      say(`Withdraw: ${(e as Error).message}`, false);
    }
  }

  render();

  if (live) {
    // The chain is the authority: read the release, the fee, the recorded lineage and who holds each circuit now.
    const rpc = new JsonRpc();
    void (async () => {
      try {
        const [rel, fee, lin] = await Promise.all([
          readRelease(rpc, records!, songKey),
          readFeeBps(rpc, records!),
          chainLineage(rpc, records!, songKey, labelOf),
        ]);
        if (!rel.exists) return;
        price = rel.price;
        feeBps = fee;
        lineage = lin;
        fromChain = true;
        const ids: Array<[string, bigint]> = [
          [songKey, onChain!.id],
          ...[...instruments.entries()].map(([k, v]) => [k, v.id] as [string, bigint]),
        ];
        const owners = await Promise.all(ids.map(([, id]) => readOwner(rpc, onChain!.processor, id).catch(() => "")));
        ids.forEach(([k], i) => owners[i] && holders.set(k, owners[i]!));
        render();
      } catch {
        /* the terms above stay on the page when the node does not answer */
      }
    })();
  }
  return box;
}
