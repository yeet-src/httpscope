/* Self-test for app/lib/probes/conns.js: one snapshot of the connection
 * inventory, joined to pids, printed as a table.
 *
 *   yeet run scripts/selftest-conns.js
 */
import { listeners, snapshot } from "../app/lib/probes/conns.js";

const t0 = Date.now();
const rows = await snapshot();
console.log(`${rows.length} sockets in ${Date.now() - t0}ms; ${listeners(rows).length} listening`);
const pad = (s, n) => String(s ?? "-").padEnd(n);
console.log(`${pad("comm", 16)} ${pad("pid", 7)} ${pad("state", 12)} ${pad("local", 28)} remote`);
for (const r of rows.sort((a, b) => (a.state > b.state ? 1 : -1))) {
  console.log(`${pad(r.comm, 16)} ${pad(r.pid, 7)} ${pad(r.state, 12)} ${pad(`${r.laddr}:${r.lport}`, 28)} ${r.raddr}:${r.rport}`);
}
yeet.exit(0);
