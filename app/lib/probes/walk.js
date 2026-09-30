/* Loading the walk VM (bin/walk.bpf.o) and running programs on it.
 *
 * The object attaches to raw_tp/tcp_probe on start and stays quiet
 * (`nfields` 0) until a program is applied: the compiled fields go
 * into the `programs` array map, then `nfields` arms them; setting it
 * back to 0 quiesces without a reload. One program runs at a time, so
 * `capture()` serialises callers.
 */

import { ArrayMap, BpfObject, DataSec, HashMap, RingBuf } from "yeet:bpf";

import { decodeEvent } from "../walk/decode.js";
import { program } from "../walk/vm.js";

const BSS = "walk.bss";
const DATA = "walk.data";

/**
 * Attach the VM. `object` is `{ exe, base? }`. Returns a handle with
 * `capture(fields, { limit, ms, gapMs })` → rows, and the counters.
 */
export async function attachWalk(object, { onError, ignorePorts = [] } = {}) {
  const control = await new BpfObject(object)
    .bind("events", { kind: "ringbuf", btf_struct: "walk_event" })
    .bind("programs", { kind: "array" })
    .bind("ignore_ports", { kind: "hash_map" })
    .bind("focus_ports", { kind: "hash_map" })
    .bind(BSS, { kind: "data" })
    .bind(DATA, { kind: "data" })
    .start();

  const programs = new ArrayMap(control, "programs");
  const ignored = new HashMap(control, "ignore_ports");
  const focused = new HashMap(control, "focus_ports");
  const bss = new DataSec(control, BSS);
  const dataSec = new DataSec(control, DATA);
  for (const port of ignorePorts) await ignored.update(Number(port), 1);

  /* Events already in the ring when a program is quiesced still arrive
   * afterwards; each carries the generation it ran under, so a row from
   * a previous program is dropped rather than credited to the next. */
  let fields = [];
  let sink = null;
  let generation = 0;
  const subscription = await new RingBuf(control, "events").subscribe(
    (wrapped) => {
      if (!fields.length || !sink) return;
      try {
        const row = decodeEvent(wrapped, fields);
        if (row.gen === generation) sink(row);
      } catch (error) {
        onError?.(error);
      }
    },
    (error) => onError?.(error),
  );

  /* Quiesce, rewrite the field programs and the filter, arm. */
  let focusPorts = [];
  const apply = async (next, { ports = [], data = false } = {}) => {
    await bss.patch({ nfields: 0 });
    for (let i = 0; i < next.length; i++) await programs.update(i, program(next[i]));
    for (const port of ports) await focused.update(Number(port), 1);
    focusPorts = ports.map(Number);
    fields = next;
    generation = (generation + 1) >>> 0 || 1;
    await bss.patch({ gen: generation, focus: ports.length ? 1 : 0, data_only: data ? 1 : 0, nfields: next.length });
  };
  const quiet = async () => {
    await bss.patch({ nfields: 0, focus: 0, data_only: 0 });
    for (const port of focusPorts) await focused.delete(port).catch(() => {});
    focusPorts = [];
    fields = [];
    sink = null;
  };

  let queue = Promise.resolve();

  return {
    control,
    /**
     * Run `fields` (from compile()) until `limit` rows or `ms` elapsed,
     * one event per `gapMs` at most; `ports` narrows to flows with one
     * of them, `data` to segments carrying payload. Resolves to the
     * rows, oldest first.
     */
    capture(next, { limit = 50, ms = 2000, gapMs = 1, ports = [], data = false } = {}) {
      const run = async () => {
        const rows = [];
        let done;
        const finished = new Promise((r) => (done = r));
        sink = (row) => {
          rows.push(row);
          if (rows.length >= limit) done();
        };
        await dataSec.patch({ min_gap_ns: BigInt(Math.max(0, Math.round(gapMs * 1e6))) });
        await apply(next, { ports, data });
        const timer = setTimeout(done, ms);
        try {
          await finished;
        } finally {
          clearTimeout(timer);
          await quiet();
        }
        return rows.slice(0, limit);
      };
      const turn = queue.then(run, run);
      queue = turn.catch(() => {});
      return turn;
    },
    async stats() {
      const live = (await bss.read()) ?? {};
      const n = (k) => Number(live[k] ?? 0);
      return { seen: n("seen"), emitted: n("emitted"), ringFull: n("ring_full"), fields: n("nfields") };
    },
    async stop() {
      await subscription.unsubscribe?.();
      await control.stop();
    },
  };
}
