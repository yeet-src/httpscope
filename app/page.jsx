/* Home: the services this machine speaks to and as, and what changed.
 *
 * One query a second against the model in this same isolate — no
 * route, no serializer. `For` on services, keyed by role and name, so
 * a service keeps its row while its numbers move.
 */
import { For, Link, createSignal, onCleanup } from "yeetkit";

import DriftTable from "@/lib/DriftTable.jsx";
import { ago } from "@/lib/fmt.js";
import { overview } from "@/lib/scope.js";

export default function Home() {
  const [view, setView] = createSignal({ status: null, services: [], drift: [] });
  const [error, setError] = createSignal(null);

  const tick = async () => {
    try {
      setView(await overview());
      setError(null);
    } catch (failure) {
      setError(String(failure?.message ?? failure));
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  onCleanup(() => clearInterval(timer));

  const status = () => view().status;

  return (
    <section class="space-y-6">
      {() => error() && <p class="text-red">error: {error()}</p>}

      {/* One line: is the capture alive. Every number sits beside its
          word; the colours are a second channel. */}
      {() =>
        status() && (
          <p class="text-dim">
            up <span class="text-fg">{ago(Date.now() - status().uptimeMs)}</span> · wire on{" "}
            <span class="text-cyan">{status().interfaces}</span> interfaces, <span class="text-cyan">{status().emitted}</span> segments · tls taps{" "}
            <span class="text-magenta">{status().tls}</span> · flows <span class="text-fg">{status().flows}</span> · transactions{" "}
            <span class="text-yellow">{status().transactions}</span>
            {status().errors ? (
              <>
                {" "}
                · errors <span class="text-red">{status().errors}</span>
              </>
            ) : null}
          </p>
        )
      }

      <div class="grid gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div class="min-w-0 space-y-1">
        <h2 class="comment">services · the APIs this machine calls and serves</h2>
        <div class="overflow-x-auto">
        <table class="w-full">
          <thead class="text-left">
            <tr class="border-b border-rule text-dim">
              <th class="py-1 pr-6 font-normal">role</th>
              <th class="py-1 pr-6 font-normal">service</th>
              <th class="py-1 pr-6 text-right font-normal">endpoints</th>
              <th class="py-1 pr-6 text-right font-normal">tx</th>
              <th class="py-1 pr-6 font-normal">clients</th>
              <th class="py-1 pr-6 font-normal">servers</th>
              <th class="py-1 text-right font-normal">last</th>
            </tr>
          </thead>
          <tbody>
            <For each={view().services}>
              {(s) => (
                <tr class="hover:bg-mode">
                  <td class="py-0.5 pr-6 text-dim">{s.role}</td>
                  <td class="py-0.5 pr-6">
                    <Link href={`/services/${s.role}/${encodeURIComponent(s.name)}`} end class="text-blue hover:underline">
                      {s.name}
                    </Link>
                  </td>
                  <td class="py-0.5 pr-6 text-right">{s.endpoints}</td>
                  <td class="py-0.5 pr-6 text-right text-yellow">{s.transactions}</td>
                  <td class="max-w-0 truncate py-0.5 pr-6 text-dim" title={s.clients.join(" ")}>
                    {s.clients.join(" ") || "–"}
                  </td>
                  <td class="max-w-0 truncate py-0.5 pr-6 text-dim" title={s.servers.join(" ")}>
                    {s.servers.join(" ") || "–"}
                  </td>
                  <td class="py-0.5 text-right text-dim">{ago(s.lastAt)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        {() => view().services.length === 0 && <p class="py-2 text-dim">nothing yet — make an HTTP request on this machine</p>}
        </div>
      </div>

      <div class="min-w-0 space-y-1">
        <h2 class="comment">
          recent drift · <Link href="/drift" end class="text-blue hover:underline">[all, live]</Link>
        </h2>
        <DriftTable events={() => view().drift} />
      </div>
      </div>
    </section>
  );
}
