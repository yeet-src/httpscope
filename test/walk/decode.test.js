import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeEntry, decodeEvent, tcpState } from "../../app/lib/walk/decode.js";
import { ENTRY_CAP, MAX_FIELDS, MAX_ITERS } from "../../app/lib/walk/vm.js";

const u8 = (...b) => new Uint8Array(b);

test("scalars: little-endian, signed, big-endian, bool, pointers", () => {
  assert.equal(decodeEntry(u8(10, 0, 0, 0), 4, { kind: "uint", size: 4 }), 10);
  assert.equal(decodeEntry(u8(0xff, 0xff, 0xff, 0xff), 4, { kind: "int", size: 4 }), -1);
  assert.equal(decodeEntry(u8(0xff, 0xff, 0xff, 0xff), 4, { kind: "uint", size: 4 }), 4294967295);
  assert.equal(decodeEntry(u8(1, 0xbb), 2, { kind: "be", size: 2 }), 443);
  assert.equal(decodeEntry(u8(0), 1, { kind: "bool", size: 1 }), false);
  assert.equal(decodeEntry(u8(2), 1, { kind: "bool", size: 1 }), true);
  assert.equal(decodeEntry(u8(0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0xff), 8, { kind: "ptr", size: 8 }), "0xff22334455667788");
  assert.equal(decodeEntry(u8(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 8, { kind: "uint", size: 8 }), "18446744073709551615", "beyond 2^53 stays exact as a string");
});

test("addresses, strings, bytes, text", () => {
  assert.equal(decodeEntry(u8(127, 0, 0, 1), 4, { kind: "ip4", size: 4 }), "127.0.0.1");
  assert.equal(decodeEntry(u8(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 10, 0, 0, 1), 16, { kind: "ip6", size: 16 }), "0:0:0:0:0:ffff:a00:1");
  assert.equal(decodeEntry(u8(101, 116, 104, 48, 0, 120, 120), 7, { kind: "str", size: 16 }), "eth0");
  assert.equal(decodeEntry(u8(71, 69, 84, 32, 47, 13, 10, 200), 8, { kind: "text", size: 8 }), "GET /··· ".trim());
  assert.equal(decodeEntry(u8(0xde, 0xad, 0x01), 3, { kind: "bytes", size: 3 }), "dead01");
});

test("enum by name, bitfield by position", () => {
  const values = { 0: "TCP_CA_Open", 3: "TCP_CA_Recovery" };
  assert.equal(decodeEntry(u8(3, 0, 0, 0), 4, { kind: "enum", size: 4, values }), "TCP_CA_Recovery");
  assert.equal(decodeEntry(u8(7, 0, 0, 0), 4, { kind: "enum", size: 4, values }), 7);
  assert.equal(decodeEntry(u8(0b0110_1010), 1, { kind: "uint", size: 1, bitfield: { bit_offset: 1, bit_size: 1 } }), 1);
  assert.equal(decodeEntry(u8(0b0110_1010), 1, { kind: "uint", size: 1, bitfield: { bit_offset: 0, bit_size: 1 } }), 0);
  assert.equal(decodeEntry(u8(0b0110_1010), 1, { kind: "uint", size: 1, bitfield: { bit_offset: 4, bit_size: 4 } }), 6);
});

test("json:<field> scans the window", () => {
  const win = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
  const body = 'HTTP/1.1 200 OK\r\n\r\n{"id": 42, "name": "ok", "on": true, "x": null}';
  assert.equal(decodeEntry(win(body), body.length, { kind: "json", size: 200, field: "id" }), 42);
  assert.equal(decodeEntry(win(body), body.length, { kind: "json", size: 200, field: "name" }), "ok");
  assert.equal(decodeEntry(win(body), body.length, { kind: "json", size: 200, field: "on" }), true);
  assert.equal(decodeEntry(win(body), body.length, { kind: "json", size: 200, field: "missing" }), null);
});

test("decodeEvent: the flow prefix and each field's entry, null where the walk failed", () => {
  const edata = new Array(MAX_FIELDS * MAX_ITERS * ENTRY_CAP).fill(0);
  const elen = new Array(MAX_FIELDS * MAX_ITERS).fill(0);
  const put = (f, bytes) => {
    elen[f * MAX_ITERS] = bytes.length;
    bytes.forEach((b, i) => (edata[f * MAX_ITERS * ENTRY_CAP + i] = b));
  };
  put(0, [10, 0, 0, 0]);
  put(1, [108, 111, 0]);
  put(3, [..."GET / HTTP/1.1\r\nHost: x\r\n"].map((c) => c.charCodeAt(0)));
  put(4, [..."garbage past the head"].map((c) => c.charCodeAt(0)));
  const e = { ts: 123n, cpu: 2, ok: 0b11011, family: 2, state: 1, sport: 38272, dport: 443, saddr: [192, 168, 1, 2], daddr: [1, 1, 1, 1], seq: 77, plen: 1200, linear: 6, fcount: [1, 1, 0, 1, 1], elen, edata };
  const fields = [
    { name: "cwnd", decode: { kind: "uint", size: 4 } },
    { name: "dev", decode: { kind: "str", size: 16 } },
    { name: "gone", decode: { kind: "uint", size: 4 } },
    { name: "req", decode: { kind: "text", size: 60, payload: 0 } },
    { name: "tail", decode: { kind: "text", size: 60, payload: 10 } },
  ];
  const row = decodeEvent({ walk_event: e }, fields);
  assert.equal(row.ts, 123n);
  assert.equal(row.cpu, 2);
  assert.equal(row.state, "ESTABLISHED");
  assert.equal(row.sport, 38272);
  assert.equal(row.dport, 443);
  assert.equal(row.saddr, "192.168.1.2");
  assert.equal(row.daddr, "1.1.1.1");
  assert.equal(row.seq, 77);
  assert.equal(row.len, 1200);
  assert.equal(row.linear, 6);
  assert.deepEqual(row.values, { cwnd: 10, dev: "lo", gone: null, req: "GET / ", tail: null }, "payload windows are cut to the linear head");
  assert.equal(tcpState(10), "LISTEN");
});
