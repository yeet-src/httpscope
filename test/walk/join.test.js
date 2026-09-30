import assert from "node:assert/strict";
import { test } from "node:test";

import { fillPayloads, rowKey, wireKey } from "../../app/lib/walk/join.js";

const bytes = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

test("a row's segment is keyed as the packet its peer sent", () => {
  const row = { saddr: "10.0.0.2", sport: 44000, daddr: "1.1.1.1", dport: 80, seq: 1000 };
  assert.equal(rowKey(row), wireKey("1.1.1.1", 80, "10.0.0.2", 44000, 1000));
  assert.equal(rowKey({ ...row, seq: -1 }), wireKey("1.1.1.1", 80, "10.0.0.2", 44000, 4294967295));
});

test("null payload windows fill from the wire's copy; others are left alone", () => {
  const fields = [
    { name: "cwnd", decode: { kind: "uint", size: 4 } },
    { name: "req", decode: { kind: "text", size: 12, payload: 0 } },
    { name: "id", decode: { kind: "json", size: 100, payload: 20, field: "id" } },
    { name: "far", decode: { kind: "text", size: 10, payload: 500 } },
  ];
  const packet = bytes('HTTP/1.1 200 OK\r\n\r\n{"id": 42}');
  const rows = [
    { saddr: "10.0.0.2", sport: 44000, daddr: "1.1.1.1", dport: 80, seq: 7, values: { cwnd: 10, req: null, id: null, far: null } },
    { saddr: "10.0.0.2", sport: 44001, daddr: "1.1.1.1", dport: 80, seq: 9, values: { cwnd: 11, req: "already", id: null, far: null } },
  ];
  const ring = new Map([[wireKey("1.1.1.1", 80, "10.0.0.2", 44000, 7), packet]]);
  const filled = fillPayloads(rows, fields, (k) => ring.get(k));
  assert.equal(filled, 2);
  assert.deepEqual(rows[0].values, { cwnd: 10, req: "HTTP/1.1 200", id: 42, far: null }, "a window past the copy stays null");
  assert.deepEqual(rows[1].values, { cwnd: 11, req: "already", id: null, far: null }, "no copy on the wire for this one");
});

test("no payload fields: nothing to do", () => {
  const rows = [{ values: { cwnd: 1 } }];
  assert.equal(fillPayloads(rows, [{ name: "cwnd", decode: { kind: "uint", size: 4 } }], () => bytes("x")), 0);
});
