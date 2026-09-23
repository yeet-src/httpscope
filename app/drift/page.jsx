/* Drift, live: what changed in the shape of any API, as it changes.
 *
 * The last hundred at load, then a stream from the pipeline — an async
 * generator in the same isolate, so an event is on the page the tick
 * it happened, and closing the tab ends the generator. */
import { createSignal, onCleanup } from "yeetkit";

import DriftTable from "@/lib/DriftTable.jsx";
import { driftStream, recentDrift } from "@/lib/scope.js";

const KEEP = 300;

export default function Drift() {
  const [events, setEvents] = createSignal([]);
  const [live, setLive] = createSignal(false);
  let stopped = false;

  (async () => {
    setEvents(await recentDrift(100).catch(() => []));
    setLive(true);
    try {
      for await (const e of driftStream()) {
        if (stopped) break;
        setEvents((all) => [e, ...all].slice(0, KEEP));
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
        drift — {() => (live() ? <span class="text-green">live</span> : <span class="text-dim">connecting</span>)} · newest first
      </h1>
      <DriftTable events={events} empty="no drift yet: an endpoint has to be seen 10–20 times before a change counts as one" />
    </section>
  );
}
