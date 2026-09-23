import assert from "node:assert/strict";
import { test } from "node:test";

import { snapshot } from "../app/lib/probes/conns.js";

test("a snapshot retries a walk that raced a dying process", async () => {
  let calls = 0;
  const graph = {
    async query(q) {
      calls++;
      if (q.includes("procs") && calls < 3) throw new Error("GraphQL Error: File not found: /proc/1234/fd");
      if (q.includes("procs")) return { data: { procs: [{ pid: 7, stat: { comm: "srv" }, fds: [{ inode: 99, kind: "SOCKET" }] }] } };
      return { data: { tcp: [{ inode: 99, state: "Listen", uid: 0, local_address: { addr: "0.0.0.0:80", port: 80 }, remote_address: { addr: "0.0.0.0:0", port: 0 } }], tcp6: [] } };
    },
  };
  const rows = await snapshot(graph);
  assert.deepEqual(rows.map((r) => [r.lport, r.pid, r.comm]), [[80, 7, "srv"]]);
  assert.ok(calls >= 3);
});
