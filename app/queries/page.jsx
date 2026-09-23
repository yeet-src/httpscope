/* Agent queries, live: what is being asked of the API and what it got.
 *
 * Every request to /api/query is recorded by the route as it starts and
 * as it finishes; this page holds the last hundred and streams changes.
 * A running query shows as such — an `| ai` stage takes seconds. Click a
 * row for the full query and the answer. */
import { For, Show, createSignal, onCleanup } from "yeetkit";

import { ago, bytes, ms } from "@/lib/fmt.js";
import { format, inlineMarkdown, prettyJson, tone as tokenTone } from "@/lib/gql.js";
import { queryStream, recentQueries } from "@/lib/scope.js";

const SHOWN = 100;

const tone = (q) => (q.state === "running" ? "text-yellow" : q.ok ? "text-green" : "text-red");
const label = (q) => (q.state === "running" ? "running" : q.ok ? `ok ${q.status ?? ""}`.trim() : `error ${q.status ?? ""}`.trim());
const oneLine = (text) => text.replace(/\s+/g, " ").trim();

/* An `ai` instruction, as light markdown inside the formatted query. */
const Prose = (props) => (
  <For each={inlineMarkdown(props.text)}>
    {(p) =>
      p.kind === "bold" ? <span class="font-bold text-fg">{p.text}</span> : p.kind === "code" ? <span class="text-green">{p.text}</span> : <span class="text-fg">{p.text}</span>
    }
  </For>
);

/* The query, formatted over lines and coloured token by token: GraphQL,
 * then each stage — JavaScript highlighted, an ai instruction as prose. */
const Query = (props) => (
  <pre class="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words">
    <For each={format(props.text)}>{(t) => (t.type === "prose" ? <Prose text={t.text} /> : <span class={tokenTone(t.type)}>{t.text}</span>)}</For>
  </pre>
);

function Row(props) {
  const [open, setOpen] = createSignal(false);
  const q = () => props.q;
  return (
    <div class="border-b border-rule/40">
      <button class="flex w-full flex-wrap items-baseline gap-x-3 py-0.5 text-left hover:bg-mode" onClick={() => setOpen(!open())}>
        <span class="w-8 shrink-0 text-right text-dim">{ago(q().at)}</span>
        <span class={`w-20 shrink-0 ${tone(q())}`}>{label(q())}</span>
        <span class="w-14 shrink-0 text-right text-cyan">{q().ms != null ? `${ms(q().ms)}ms` : ""}</span>
        <span class="w-12 shrink-0 text-right text-dim">{q().bytes ? bytes(q().bytes) : ""}</span>
        <span class="min-w-0 flex-1 truncate">
          {oneLine(q().query)}
          <Show when={q().state === "running" && q().stream}>
            <span class="text-green"> ▸ {oneLine(q().stream).slice(-100)}</span>
          </Show>
        </span>
        <span class="shrink-0 text-magenta">{q().stages.join(" ")}</span>
        <span class="max-w-64 shrink-0 truncate text-dim" title={q().client ?? ""}>
          {q().client ?? "–"}
        </span>
      </button>
      <Show when={open()}>
        <div class="space-y-3 py-2 pl-8">
          <div class="min-w-0 space-y-1">
            <p class="text-dim">
              query · {q().method}
              {q().variables ? ` · variables ${q().variables}` : ""}
            </p>
            <Query text={q().query} />
          </div>
          <div class="min-w-0 space-y-1">
            <p class="text-dim">
              answer
              {q().state === "running" ? (q().stream ? " · the model is writing" : " · waiting") : ""}
              {q().rows ? ` · ${Object.entries(q().rows).map(([k, n]) => `${k}: ${n}`).join(", ")}` : ""}
              {q().ms != null ? ` · ${ms(q().ms)}ms` : ""}
            </p>
            <Show when={q().errors.length}>
              <For each={q().errors}>{(e) => <p class="text-red">{e}</p>}</For>
            </Show>
            {/* While it runs, the answer is whatever the model has said so far;
                once done, the result itself. */}
            <Show when={q().state === "running"} fallback={<Show when={q().preview}><pre class="max-h-[40rem] overflow-auto whitespace-pre-wrap break-words text-green">{prettyJson(q().preview)}</pre></Show>}>
              <Show when={q().stream} fallback={<p class="text-dim">…</p>}>
                <pre class="max-h-[40rem] overflow-auto whitespace-pre-wrap break-words text-green">
                  {q().stream}
                  <span class="caret" />
                </pre>
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

export default function Queries() {
  const [rows, setRows] = createSignal([]);
  const [live, setLive] = createSignal(false);
  let stopped = false;

  (async () => {
    setRows(await recentQueries(SHOWN).catch(() => []));
    setLive(true);
    try {
      for await (const q of queryStream()) {
        if (stopped) break;
        setRows((all) => {
          const i = all.findIndex((x) => x.id === q.id);
          if (i >= 0) return all.map((x) => (x.id === q.id ? q : x));
          return [q, ...all].slice(0, SHOWN);
        });
      }
    } catch {
      setLive(false);
    }
  })();
  onCleanup(() => {
    stopped = true;
  });

  return (
    <section class="space-y-4">
      <h1 class="comment">
        queries — what agents are asking · {() => (live() ? <span class="text-green">live</span> : <span class="text-dim">connecting</span>)} · click one for the query and its answer
      </h1>
      <div>
        <For each={rows()} fallback={<p class="text-dim">no queries yet — POST one to /api/query</p>}>
          {(q) => <Row q={q} />}
        </For>
      </div>
    </section>
  );
}
