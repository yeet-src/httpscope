/* Drift events as a table: when, what kind, where, and the detail.
 *
 * One component for the home page, the drift page and an endpoint's own
 * drift, so the columns line up the same everywhere. `events` is an
 * accessor; `where` hides the service/method/path columns when every
 * row is about the same endpoint. */
import { For, Link } from "yeetkit";

import { clock, driftTone } from "@/lib/fmt.js";

export default function DriftTable(props) {
  const where = () => props.where !== false;
  return (
    <div class="overflow-x-auto">
      <table class="w-full">
        <thead class="text-left">
          <tr class="border-b border-rule text-dim">
            <th class="py-1 pr-5 font-normal">time</th>
            <th class="py-1 pr-5 font-normal">kind</th>
            {where() && <th class="py-1 pr-5 font-normal">service</th>}
            {where() && <th class="py-1 pr-5 font-normal">method</th>}
            {where() && <th class="py-1 pr-5 font-normal">path</th>}
            <th class="py-1 font-normal">detail</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.events()} fallback={<tr><td colspan={where() ? 6 : 3} class="py-2 text-dim">{props.empty ?? "none yet"}</td></tr>}>
            {(e) => (
              <tr class="hover:bg-mode">
                <td class="whitespace-nowrap py-0.5 pr-5 text-dim">{clock(e.at)}</td>
                <td class={`whitespace-nowrap py-0.5 pr-5 ${driftTone(e.kind)}`}>{e.kind}</td>
                {where() && (
                  <td class="max-w-48 truncate py-0.5 pr-5" title={e.service}>
                    <Link href={`/services/${e.role}/${encodeURIComponent(e.service)}`} end class="text-blue hover:underline">
                      {e.service}
                    </Link>
                  </td>
                )}
                {where() && <td class="py-0.5 pr-5 text-magenta">{e.method}</td>}
                {where() && (
                  <td class="max-w-72 truncate py-0.5 pr-5" title={e.path}>
                    {e.path}
                  </td>
                )}
                <td class="max-w-0 truncate py-0.5 text-dim" title={e.detail}>
                  {e.detail}
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
