/* One service: its endpoints, with statistics and a way into each. */
import { For, Link, createEffect, createSignal, onCleanup } from "yeetkit";

import { Path } from "@/lib/Highlight.jsx";
import { ago, errorsOf, ms, statuses } from "@/lib/fmt.js";
import { serviceEndpoints } from "@/lib/scope.js";

export default function Service(props) {
  const [rows, setRows] = createSignal([]);
  const [error, setError] = createSignal(null);

  createEffect(() => {
    const role = props.params.role;
    const name = decodeURIComponent(props.params.name);
    let stopped = false;
    const tick = async () => {
      try {
        const next = await serviceEndpoints(role, name);
        if (!stopped) setRows(next);
        setError(null);
      } catch (failure) {
        setError(String(failure?.message ?? failure));
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
    <section class="space-y-4">
      <Link href="/" end class="text-blue hover:underline">
        [back to *home*]
      </Link>
      <h1 class="comment">
        {() => props.params.role} <span class="text-fg">{() => decodeURIComponent(props.params.name)}</span>
      </h1>
      {() => error() && <p class="text-red">error: {error()}</p>}

      <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="text-left">
            <tr class="border-b border-rule text-dim">
              <th class="py-1 pr-4 font-normal">method</th>
              <th class="py-1 pr-6 font-normal">path</th>
              <th class="py-1 pr-6 text-right font-normal">tx</th>
              <th class="py-1 pr-6 font-normal">statuses</th>
              <th class="py-1 pr-6 text-right font-normal">p50 ms</th>
              <th class="py-1 pr-6 text-right font-normal">p95 ms</th>
              <th class="py-1 pr-6 font-normal">response</th>
              <th class="py-1 text-right font-normal">last</th>
            </tr>
          </thead>
          <tbody>
            <For each={rows()}>
              {(e) => (
                <tr class="hover:bg-mode">
                  <td class="py-0.5 pr-4 text-magenta">{e.method}</td>
                  <td class="py-0.5 pr-6">
                    <Link href={`/endpoints/${e.id}`} end class="hover:underline">
                      <Path text={e.path} />
                    </Link>
                  </td>
                  <td class="py-0.5 pr-6 text-right text-yellow">{e.n}</td>
                  <td class={`py-0.5 pr-6 ${errorsOf(e.statuses) ? "text-red" : "text-dim"}`}>{statuses(e.statuses)}</td>
                  <td class="py-0.5 pr-6 text-right text-cyan">{ms(e.latency.p50)}</td>
                  <td class="py-0.5 pr-6 text-right text-cyan">{ms(e.latency.p95)}</td>
                  <td class="max-w-0 truncate py-0.5 pr-6 text-dim" title={e.resShape ?? ""}>
                    {e.resType ?? "–"}
                    {e.resShape ? ` ${e.resShape.replace(/\s+/g, " ")}` : ""}
                  </td>
                  <td class="py-0.5 text-right text-dim">{ago(e.lastAt)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        {() => rows().length === 0 && <p class="py-2 text-dim">no endpoints seen for this service</p>}
      </div>
    </section>
  );
}
