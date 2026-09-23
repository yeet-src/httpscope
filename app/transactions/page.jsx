/* Recent transactions, newest first, each with its headers and bodies.
 *
 * The bodies are the point: what a request actually said, what came
 * back. The ring in the pipeline keeps the last thousand with up to
 * 16 KiB of each body, inflated if it arrived compressed. Polled once a
 * second; a row opens on click, in the isolate, one event over the
 * socket. */
import { For, Link, Show, createSignal, onCleanup } from "yeetkit";

import { ago, bytes, ms } from "@/lib/fmt.js";
import { recentTransactions } from "@/lib/scope.js";

const SHOWN = 100;

const tone = (status) => (status == null ? "text-dim" : status >= 500 ? "text-red" : status >= 400 ? "text-yellow" : "text-green");
const transport = (t) => (t === 2 ? "wire" : t === 1 ? "tls" : "tcp");

/* One transaction: a line, and the exchange under it when opened. */
function Row(props) {
  const [open, setOpen] = createSignal(false);
  const t = () => props.tx;
  return (
    <div class="border-b border-rule/40">
      {/* A div, not a button: the text stays selectable. The expanded
          query and answer live outside it, so selecting them never
          toggles the row. */}
      <div role="button" tabindex="0" class="flex w-full cursor-pointer select-text flex-wrap items-baseline gap-x-3 py-0.5 text-left hover:bg-mode" onClick={() => setOpen(!open())} title={open() ? "collapse" : "expand"}>
        <span class="shrink-0 text-blue">{open() ? "[-]" : "[+]"}</span>
        <span class="w-8 text-dim">{ago(t().at)}</span>
        <span class={`w-8 ${tone(t().status)}`}>{t().status ?? "–"}</span>
        <span class="text-magenta">{t().method}</span>
        <span class="text-dim">{t().service}</span>
        <span class="min-w-0 truncate">{t().target}</span>
        <span class="ml-auto text-cyan">{ms(t().duration)}ms</span>
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
            <pre class="whitespace-pre-wrap break-all text-dim">{t().requestHeaders.map(([n, v]) => `${n}: ${v}`).join("\n")}</pre>
            <Show when={t().requestBody}>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all text-fg">{t().requestBody}</pre>
            </Show>
          </div>
          <div class="min-w-0 space-y-1">
            <p class="text-dim">
              response · {bytes(t().responseBodyLength)}
            </p>
            <pre class="whitespace-pre-wrap break-all text-dim">{t().responseHeaders.map(([n, v]) => `${n}: ${v}`).join("\n")}</pre>
            <Show when={t().responseBody} fallback={<p class="text-dim">{t().responseBodyLength ? "body not readable (cut, or not text)" : "no body"}</p>}>
              <pre class="max-h-96 overflow-auto whitespace-pre-wrap break-all text-green">{t().responseBody}</pre>
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

  const tick = async () => {
    try {
      setRows(await recentTransactions(null, SHOWN));
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
        <a href="/api" class="text-blue hover:underline">
          [query them]
        </a>
      </h1>
      {() => error() && <p class="text-red">error: {error()}</p>}
      <div>
        <For each={rows()} fallback={<p class="text-dim">nothing yet — make an HTTP request on this machine</p>}>
          {(tx) => <Row tx={tx} />}
        </For>
      </div>
    </section>
  );
}
