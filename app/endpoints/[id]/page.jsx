/* One endpoint in full: its shapes, per status, with examples; its
 * statistics; the drift that touched it. */
import { For, Link, Show, createEffect, createSignal, onCleanup } from "yeetkit";

import DriftTable from "@/lib/DriftTable.jsx";
import { Body as BodyText } from "@/lib/Highlight.jsx";
import { ago, bytes, clock, ms, statuses } from "@/lib/fmt.js";
import { endpointDetail, recentTransactions } from "@/lib/scope.js";

const RECENT = 10;

const Row = (label, value) => (
  <div class="flex gap-4">
    <dt class="w-24 shrink-0 text-dim">{label}</dt>
    <dd class="min-w-0 break-words text-fg">{value}</dd>
  </div>
);

const Body = (props) => (
  <div class="space-y-1">
    <Show when={props.body.shape} fallback={<p class="text-dim">{props.body.text ? `${props.body.text} text bodies` : Object.keys(props.body.encoded ?? {}).length ? `compressed, not read: ${Object.keys(props.body.encoded).join(", ")}` : "no body"}</p>}>
      <pre class="whitespace-pre-wrap text-green">{props.body.shape}</pre>
      <Show when={props.body.example}>
        <p class="text-dim">example</p>
        <BodyText text={props.body.example} class="max-h-64 overflow-auto" />
      </Show>
    </Show>
  </div>
);

export default function EndpointPage(props) {
  const [ep, setEp] = createSignal(null);
  const [gone, setGone] = createSignal(false);
  const [recent, setRecent] = createSignal([]);

  createEffect(() => {
    const id = props.params.id;
    let stopped = false;
    const tick = async () => {
      const next = await endpointDetail(id).catch(() => null);
      if (stopped) return;
      setGone(!next);
      if (next) {
        setEp(next);
        const where = { role: next.role.toUpperCase(), service: { eq: next.service }, method: { eq: next.method }, path: { eq: next.path } };
        setRecent(await recentTransactions(where, RECENT).catch(() => []));
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    onCleanup(() => {
      stopped = true;
      clearInterval(timer);
    });
  });

  return (
    <section class="space-y-6">
      <Show when={ep()} fallback={<p class="text-dim">{() => (gone() ? "no such endpoint (yet)" : "loading…")}</p>}>
        {(e) => (
          <>
            <Link href={`/services/${e().role}/${encodeURIComponent(e().service)}`} end class="text-blue hover:underline">
              [back to *{e().service}*]
            </Link>
            <h1 class="comment">
              <span class="text-magenta">{e().method}</span> <span class="text-fg">{e().path}</span>
            </h1>

            <dl class="space-y-1">
              {Row("service", () => `${e().role} ${e().service}`)}
              {Row("seen", () => `${e().n} transactions, ${e().incomplete} cut · first ${ago(e().firstAt)} ago · last ${ago(e().lastAt)} ago`)}
              {Row("statuses", () => statuses(e().statuses))}
              {Row("latency", () => `p50 ${ms(e().latency.p50)} · p95 ${ms(e().latency.p95)} · p99 ${ms(e().latency.p99)} · max ${ms(e().latency.max)} ms`)}
              {Row("by", () => e().pids.join(" ") || "–")}
              {Row(
                "query",
                () =>
                  e().query.length
                    ? e().query.map((q) => `${q.name}<${Object.keys(q.kinds).join("|")}>×${q.n}`).join("  ")
                    : "–",
              )}
            </dl>

            <div class="space-y-6">
            <div class="min-w-0 space-y-2">
              <h2 class="comment">
                request <span class="text-dim">{() => e().reqType ?? ""} · headers {() => Object.keys(e().reqHeaders ?? {}).join(" ")}</span>
              </h2>
              {() => <Body body={e().reqBody} />}
              <p class="text-dim">body bytes p50 {() => bytes(e().reqBodyBytes?.p50)} · max {() => bytes(e().reqBodyBytes?.max)}</p>
            </div>

            <div class="min-w-0 space-y-3">
              <h2 class="comment">
                responses <span class="text-dim">{() => e().resType ?? ""} · headers {() => Object.keys(e().resHeaders ?? {}).join(" ")}</span>
              </h2>
              <For each={Object.entries(e().resBodies ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))}>
                {([status, body]) => (
                  <div class="space-y-1">
                    <p>
                      <span class={Number(status) >= 400 ? "text-red" : "text-yellow"}>{status}</span>{" "}
                      <span class="text-dim">
                        {body.n} json · {body.text} text{body.inflated ? ` · ${body.inflated} inflated` : ""}
                      </span>
                    </p>
                    <Body body={body} />
                  </div>
                )}
              </For>
              <p class="text-dim">body bytes p50 {() => bytes(e().resBodyBytes?.p50)} · max {() => bytes(e().resBodyBytes?.max)}</p>
            </div>
            </div>

            <div class="space-y-3">
              <h2 class="comment">
                recent · the last {RECENT} exchanges, with bodies ·{" "}
                <Link href="/transactions" end class="text-blue hover:underline">
                  [all transactions]
                </Link>
              </h2>
              <For each={recent()} fallback={<p class="text-dim">none in the ring</p>}>
                {(t) => (
                  <div class="space-y-1 border-b border-rule/40 pb-2">
                    <p>
                      <span class="text-dim">{clock(t.at)}</span> <span class={t.status >= 400 ? "text-red" : "text-yellow"}>{t.status ?? "–"}</span> {t.target}{" "}
                      <span class="text-cyan">{ms(t.duration)}ms</span> <span class="text-dim">{t.comm ? `${t.comm}:${t.pid}` : ""}</span>
                    </p>
                    <Show when={t.requestBody}>
                      <p class="text-dim">→ request</p>
                      <BodyText text={t.requestBody} class="max-h-40 overflow-auto" />
                    </Show>
                    <Show when={t.responseBody} fallback={<p class="text-dim">← {t.responseBodyLength ? "body not readable" : "no body"}</p>}>
                      <p class="text-dim">← response</p>
                      <BodyText text={t.responseBody} class="max-h-60 overflow-auto" />
                    </Show>
                  </div>
                )}
              </For>
            </div>

            <div class="space-y-1">
              <h2 class="comment">drift</h2>
              <DriftTable events={() => e().drift} where={false} empty="none" />
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
