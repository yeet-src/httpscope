/* Self-test for the socket tap: attach bin/socket.bpf.o, arm a port (or
 * a pid), and print every captured window until --secs elapse.
 *
 *   yeet run scripts/selftest-socket.js -- --port 8080 [--secs 10]
 *   yeet run scripts/selftest-socket.js -- --pid 1234
 *   yeet run scripts/selftest-socket.js -- --all
 *
 * Generate traffic against the port while it runs (a python -m
 * http.server and a curl are enough) and each side of the exchange
 * appears with its pid, direction and the start of the bytes.
 */
import { ascii } from "../app/lib/probes/records.js";
import { attachSocket } from "../app/lib/probes/socketcore.js";

const argv = yeet.args ?? {};
const secs = Number(argv.secs ?? 10);

let count = 0;
let shapeShown = false;
const session = await attachSocket(
  { exe: "../bin/socket.bpf.o", base: import.meta.dirname },
  {
    ignorePorts: [3000, 3001, 3002],
    onData(r) {
      count++;
      if (!shapeShown) {
        shapeShown = true;
        console.log(`first record: data is ${r.data?.constructor?.name} len=${r.data.length} ts=${typeof r.ts}`);
      }
      const arrow = r.dir ? "→" : "←";
      const seg = r.len > r.capLen ? ` [${r.off}+${r.capLen}/${r.len}]` : "";
      console.log(`${String(r.pid).padStart(7)} ${arrow} ${r.saddr}:${r.sport} ${r.daddr}:${r.dport} ${String(r.capLen).padStart(5)}b${seg}  ${ascii(r.data, 72)}`);
      if (argv.hex) console.log(`        len=${r.len} off=${r.off} hex=${[...r.data.subarray(0, 48)].map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    },
    onError: (e) => console.log("error:", e?.message ?? e),
  },
);

if (argv.all) await session.captureAll(true);
if (argv.port) for (const p of String(argv.port).split(",")) await session.focusPort(p);
if (argv.pid) for (const p of String(argv.pid).split(",")) await session.focusPid(p);
console.log("armed:", JSON.stringify(await session.settings()), `— listening ${secs}s`);

await new Promise((r) => setTimeout(r, secs * 1000));
console.log(`${count} records`);
await session.stop();
yeet.exit(0);
