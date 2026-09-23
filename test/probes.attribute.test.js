import assert from "node:assert/strict";
import { test } from "node:test";

import { attribute, sameAddr } from "../app/lib/probes/attribute.js";

const rows = [
  { state: "Listen", laddr: "0.0.0.0", lport: 8089, pid: 10, comm: "python3" },
  { state: "Established", laddr: "127.0.0.1", lport: 40000, pid: 20, comm: "curl" },
  { state: "Listen", laddr: "::", lport: 443, pid: 30, comm: "nginx" },
];

test("a live socket names its owner; a listener names the server after the connection is gone", () => {
  const flow = { a: { addr: "127.0.0.1", port: 40000 }, b: { addr: "127.0.0.1", port: 8089 } };
  const who = attribute(flow, rows);
  assert.deepEqual(who, { a: { pid: 20, comm: "curl", via: "socket" }, b: { pid: 10, comm: "python3", via: "listener" } });
  const gone = attribute({ a: { addr: "127.0.0.1", port: 40001 }, b: flow.b }, rows);
  assert.equal(gone.a, null);
  assert.equal(gone.b.pid, 10);
});

test("a v6 any-address listener matches the tap's uncompressed spelling", () => {
  const who = attribute({ a: { addr: "0:0:0:0:0:0:0:1", port: 55555 }, b: { addr: "0:0:0:0:0:0:0:1", port: 443 } }, rows);
  assert.equal(who.b.comm, "nginx");
  assert.ok(sameAddr("::1", "0:0:0:0:0:0:0:1"));
  assert.ok(sameAddr("0:0:0:0:0:ffff:7f00:1", "127.0.0.1"));
});
