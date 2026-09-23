/* Recent transactions, newest first, each with its headers and bodies.
 *
 * The bodies are the point: what a request actually said, what came
 * back. The ring in the pipeline keeps the last thousand with up to
 * 16 KiB of each body, inflated if it arrived compressed. Polled once a
 * second; a row opens on click, in the isolate, one event over the
 * socket. */
import { For, Link, Show, createSignal, onCleanup } from "yeetkit";

import { Body, Headers } from "@/lib/Highlight.jsx";
import { bytes, clock, duration } from "@/lib/fmt.js";
import { recentTransactions } from "@/lib/scope.js";

const SHOWN = 100;

const tone = (status) => (status == null ? "text-dim" : status >= 500 ? "text-red" : status >= 400 ? "text-yellow" : "text-green");
const transport = (t) => (t === 2 ? "wire" : t === 1 ? "tls" : "tcp");

/* One transaction: a line, and the exchange under it when opened. */
/* Open/closed lives with the page, keyed by transaction id: the list is
 * replaced on every poll, and state kept inside a row would reset. */
function Row(props) {
  const open = () => props.open;
  const setOpen = (v) => props.toggle(v);
  const t = () => props.tx;
  return (
    <div class="border-b border-rule/40">
      {/* A div, not a button: the text stays selectable. The expanded
          query and answer live outside it, so selecting them never
          toggles the row. */}
      <div role="button" tabindex="0" class="flex w-full cursor-pointer select-text flex-wrap items-baseline gap-x-3 py-0.5 text-left hover:bg-mode" onClick={() => setOpen(!open())} title={open() ? "collapse" : "expand"}>
        <span class="shrink-0 text-blue">{open() ? "[-]" : "[+]"}</span>
        <span class="shrink-0 text-dim">{clock(t().at)}</span>
        <span class={`w-8 ${tone(t().status)}`}>{t().status ?? "–"}</span>
        <span class="text-magenta">{t().method}</span>
        <span class="text-dim">{t().service}</span>
        <span class="min-w-0 truncate">{t().target}</span>
        <span class="ml-auto text-cyan">{duration(t().duration)}</span>
        <span class="text-dim">
          {transport(t().transport)} {t().comm ? `${t().comm}:${t().pid}` : t().pid ? `pid ${t().pid}` : ""}
          {t().complete ? "" : ` cut: ${t().cut}`}
        </span>
      </div>
      <Show when={open()}>
        <div class="space-y-3 py-2 pl-8">
          <div class="min-w-0 space-y-1">
            <p class="text-dim">
              request · {bytes(t().requestBodyLength)}
            </p>
            <Headers headers={t().requestHeaders} />
            <Show when={t().requestBody}>
              <Body text={t().requestBody} />
            </Show>
          </div>
          <div class="min-w-0 space-y-1">
            <p class="text-dim">
              response · {bytes(t().responseBodyLength)}
            </p>
            <Headers headers={t().responseHeaders} />
            <Show when={t().responseBody} fallback={<p class="text-dim">{t().responseBodyLength ? "body not readable (cut, or not text)" : "no body"}</p>}>
              <Body text={t().responseBody} />
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default function Transactions() {
  const [rows, setRows] = createSignal([]);
  const [error, setError] = createSignal(null);
  const [openIds, setOpenIds] = createSignal(new Set());
  /* While a row is open the list holds still: new arrivals wait here,
   * counted in a line at the top, until every row is closed again or
   * the line is clicked. Rows already shown keep updating. */
  const [held, setHeld] = createSignal(null);
  const toggle = (id) => (on) =>
    setOpenIds((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      if (next.size === 0 && held()) release();
      return next;
    });
  const closeAll = () => {
    setOpenIds(new Set());
    release();
  };
  const release = () => {
    const h = held();
    if (h) setRows(h);
    setHeld(null);
  };

  /* A transaction never changes once recorded, so a row already on
   * screen keeps its object: `For` then leaves its nodes alone and only
   * the new rows are inserted. */
  const merge = (fresh, cur) => {
    const byId = new Map(cur.map((r) => [r.id, r]));
    return fresh.map((f) => byId.get(f.id) ?? f);
  };

  const tick = async () => {
    try {
      const fresh = merge(await recentTransactions(null, SHOWN), rows());
      if (openIds().size > 0) {
        const shown = new Set(rows().map((r) => r.id));
        /* Hold the new rows back; what is on screen stays where it is. */
        setHeld(fresh.some((f) => !shown.has(f.id)) ? fresh : null);
      } else setRows(fresh);
      setError(null);
    } catch (failure) {
      setError(String(failure?.message ?? failure));
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));

  return (
    <section class="space-y-4">
      <h1 class="comment">
        transactions — the last {SHOWN}, newest first · [+] opens headers and bodies ·{" "}
        <a href="/api" target="_blank" rel="noopener" class="text-blue hover:underline">
          [query them]
        </a>
      </h1>
      {() => error() && <p class="text-red">error: {error()}</p>}
      <Show when={held()}>
        <p class="flex items-baseline gap-4 border-b border-rule py-0.5 text-yellow">
          <span>▲ {held().filter((f) => !rows().some((r) => r.id === f.id)).length} new while a row is open</span>
          <button class="text-blue hover:underline" onClick={release}>
            [show]
          </button>
          <button class="text-blue hover:underline" onClick={closeAll}>
            [close all]
          </button>
        </p>
      </Show>
      <div>
        <For each={rows()} fallback={<p class="text-dim">nothing yet — make an HTTP request on this machine</p>}>
          {(tx) => <Row tx={tx} open={openIds().has(tx.id)} toggle={toggle(tx.id)} />}
        </For>
      </div>
    </section>
  );
}
