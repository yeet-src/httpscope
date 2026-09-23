/* Loading the wire tap (bin/wire.bpf.o) and driving its filter.
 *
 * TCX on every interface, ingress and egress; the object's programs
 * name the hook in their section. The loopback device's index is
 * patched into the object so its ingress side is skipped — a loopback
 * packet crosses lo out and in, and one copy is enough. The filter is
 * ports and capture-all, in the kernel; there is no pid there.
 *
 * Attribution comes afterwards, from the inventory (attribute.js): a
 * flow's two endpoints mapped to the processes holding those sockets,
 * which on loopback is both sides of the exchange.
 */

import { BpfObject, DataSec, HashMap, RingBuf } from "yeet:bpf";

import { wireRecord } from "./records.js";

const BSS = "wire.bss";

/** The host's interfaces from the graph: `[{ name, index }]`. */
export async function interfaces(graph = yeet.graph) {
  const r = await graph.query(`{ network_interfaces { name index } }`).catch(() => null);
  return r?.data?.network_interfaces ?? [];
}

/** The loopback interface's index, from the graph; 1 when in doubt. */
export async function loopbackIfindex(graph = yeet.graph) {
  return (await interfaces(graph)).find((i) => i.name === "lo")?.index ?? 1;
}

/**
 * Attach the wire tap. `object` is `{ exe, base? }`. `onRecord(rec)`
 * receives every segment as a wireRecord; feed them to a Reassembler.
 * `ifindex`, when given, limits the attach to those interfaces;
 * otherwise every interface the graph lists, **named explicitly** —
 * the daemon's wildcard attach skips loopback (it believed TCX
 * returned EINVAL there; it does not, on this kernel), and an explicit
 * list is attached as given, `lo` included.
 */
export async function attachWire(object, { onRecord, onError, ignorePorts = [], loIfindex = 1, ifindex, ns, graph } = {}) {
  if (!ifindex) ifindex = (await interfaces(graph ?? yeet.graph)).map((i) => i.index);
  /* The daemon's own shape for the scope; the `ns`/`ifindex` sugar on
   * top of it only exists in newer clients, so this speaks the wire form. */
  const handle = ns == null || ns === "host" ? { kind: "host" } : ns.pid ? { kind: "pid", pid: ns.pid } : { kind: "path", path: ns.path };
  const scope = ifindex.length || ns ? { net: { handle, ...(ifindex.length ? { ifindex } : {}) } } : {};
  const control = await new BpfObject(object)
    .bind("frames", { kind: "ringbuf", btf_struct: "wire_event" })
    .bind("focus_ports", { kind: "hash_map" })
    .bind("ignore_ports", { kind: "hash_map" })
    .bind(BSS, { kind: "data" })
    .attach("wire_ingress", { kind: "tcx", ...scope })
    .attach("wire_egress", { kind: "tcx", ...scope })
    .start();

  const focusPorts = new HashMap(control, "focus_ports");
  const ignored = new HashMap(control, "ignore_ports");
  const bss = new DataSec(control, BSS);
  await bss.patch({ lo_ifindex: loIfindex });

  const armed = { ports: new Set(), ignore: new Set(), all: false };
  for (const port of ignorePorts) {
    await ignored.update(Number(port), 1);
    armed.ignore.add(Number(port));
  }

  const subscription = await new RingBuf(control, "frames").subscribe(
    (wrapped) => {
      try {
        onRecord?.(wireRecord(wrapped));
      } catch (error) {
        onError?.(error);
      }
    },
    (error) => onError?.(error),
  );

  const toggle = async (map, set, key, on) => {
    key = Number(key);
    if (on) {
      await map.update(key, 1);
      set.add(key);
    } else {
      await map.delete(key).catch(() => {});
      set.delete(key);
    }
  };

  return {
    control,
    /** The interface indices the tap was attached to. */
    ifindex,
    async captureAll(on) {
      await bss.patch({ capture_all: on ? 1 : 0 });
      armed.all = Boolean(on);
    },
    focusPort: (port, on = true) => toggle(focusPorts, armed.ports, port, on),
    ignorePort: (port, on = true) => toggle(ignored, armed.ignore, port, on),
    async settings() {
      const live = await bss.read();
      return { all: Boolean(live?.capture_all), lo: Number(live?.lo_ifindex ?? 0), ports: [...armed.ports], ignore: [...armed.ignore] };
    },
    /** The kernel-side counters: packets seen per hook, parsed, matched, emitted. */
    async stats() {
      const live = (await bss.read()) ?? {};
      const n = (k) => Number(live[k] ?? 0);
      return { ingress: n("seen_ingress"), egress: n("seen_egress"), lo: n("seen_lo"), loIngress: n("seen_lo_ingress"), parsed: n("parsed"), matched: n("matched"), emitted: n("emitted"), ringFull: n("ring_full") };
    },
    async stop() {
      await subscription.unsubscribe?.();
      await control.stop();
    },
  };
}

export { attribute } from "./attribute.js";
