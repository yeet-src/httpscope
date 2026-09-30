/* Self-test for the walk VM: compile a selection against this kernel's
 * BTF, run it on tcp_probe, print the rows.
 *
 *   yeet run scripts/selftest-walk.js
 *   yeet run scripts/selftest-walk.js -- --select "cwnd,srtt,iface: sock.sk_dst_cache.dev.name" --limit 10 --ms 5000
 *   yeet run scripts/selftest-walk.js -- --plan --select "req: payload(0, 80, text)"
 *   yeet run scripts/selftest-walk.js -- --ports 8093 --data --select "req: payload(0, 80, text)"
 *
 * Generate traffic meanwhile (curl a few sites); the tracepoint is
 * receive-side, so rows come as responses arrive.
 */
import btf from "yeet:btf";

import { attachWalk } from "../app/lib/probes/walk.js";
import { compile } from "../app/lib/walk/compile.js";
import { opText } from "../app/lib/walk/vm.js";

const argv = yeet.args ?? {};
const select = String(argv.select ?? "cwnd, srtt, mss, inflight: tcp.snd_nxt - tcp.snd_una, ca, iface: sock.sk_dst_cache.dev.name, proto, req: payload(0, 60, text)")
  .split(/,(?![^(]*\))/)
  .map((s) => s.trim())
  .filter(Boolean);
const limit = Number(argv.limit ?? 20);
const ms = Number(argv.ms ?? 5000);

const fields = await compile(btf, select);
for (const f of fields) console.log(`${f.name.padEnd(12)} ${JSON.stringify(f.decode).padEnd(48)} ${[...f.pre, ...f.body].map(opText).join("; ")}`);
if (argv.plan) yeet.exit(0);

const walk = await attachWalk({ exe: "../bin/walk.bpf.o", base: import.meta.dirname }, { ignorePorts: [3000], onError: (e) => console.error("walk:", e?.message ?? e) });
console.log(`attached; capturing up to ${limit} rows for ${ms} ms…`);
const ports = String(argv.ports ?? "").split(",").map(Number).filter(Boolean);
const rows = await walk.capture(fields, { limit, ms, gapMs: Number(argv.every ?? 1), ports, data: Boolean(argv.data) });
for (const r of rows) console.log(`${(Number(r.ts % 1_000_000_000n) / 1e6).toFixed(1).padStart(7)}ms cpu${r.cpu} ${r.state.padEnd(11)} ${r.saddr}:${r.sport} → ${r.daddr}:${r.dport} seq=${r.seq} len=${r.len}/${r.linear}  ${JSON.stringify(r.values)}`);
console.log(`${rows.length} rows; counters ${JSON.stringify(await walk.stats())}`);
await walk.stop();
