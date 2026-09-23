import assert from "node:assert/strict";
import { test } from "node:test";

import { bytesOfString, latin1 } from "../../app/lib/http/bytes.js";
import { Decoder } from "../../app/lib/http/decoder.js";
import { Reassembler, connKeyOf, flowKey } from "../../app/lib/http/tcp.js";
import { TCPF_ACK, TCPF_FIN, TCPF_PSH, TCPF_RST, TCPF_SYN } from "../../app/lib/probes/records.js";

const A = { addr: "127.0.0.1", port: 40000 };
const B = { addr: "127.0.0.1", port: 8089 };
let ts = 5_000_000n;

/* One wire record: `from` → `to`, payload `text` at `seq`. */
const seg = (from, to, seq, text = "", flags = TCPF_ACK | (text ? TCPF_PSH : 0), extra = {}) => {
  const data = bytesOfString(text);
  ts += 1000n;
  return {
    ts,
    at: 0,
    ifindex: 1,
    hook: 1,
    family: 2,
    tcpflags: flags,
    sport: from.port,
    dport: to.port,
    saddr: from.addr,
    daddr: to.addr,
    seq: seq >>> 0,
    ack: 0,
    len: data.length,
    off: 0,
    capLen: data.length,
    data,
    ...extra,
  };
};

const setup = (opts = {}) => {
  let now = 1000;
  const out = [];
  const closed = [];
  const r = new Reassembler({ now: () => now, onRecord: (x) => out.push(x), onClose: (k, why) => closed.push([k, why]), ...opts });
  const text = (dir) => latin1(concat(out.filter((x) => x.dir === dir).map((x) => x.data)));
  return { r, out, closed, text, tick: (ms) => ((now += ms), r.tick()) };
};
const concat = (parts) => {
  const o = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) o.set(p, i), (i += p.length);
  return o;
};

test("flowKey is the same both ways", () => {
  assert.equal(flowKey(seg(A, B, 1)), flowKey(seg(B, A, 1)));
});

test("in-order segments both ways become two streams oriented at the SYN sender", () => {
  const { r, out, text } = setup();
  r.push(seg(A, B, 100, "", TCPF_SYN));
  r.push(seg(B, A, 500, "", TCPF_SYN | TCPF_ACK));
  r.push(seg(A, B, 101, "GET / HTTP/1.1\r\n\r\n"));
  r.push(seg(B, A, 501, "HTTP/1.1 200 OK\r\n"));
  r.push(seg(B, A, 518, "Content-Length: 0\r\n\r\n"));
  assert.equal(text(1), "GET / HTTP/1.1\r\n\r\n");
  assert.equal(text(0), "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
  assert.equal(out[0].sport, A.port, "the process side is the SYN sender");
  assert.equal(out[0].dport, B.port);
  assert.equal(out[0].transport, 2);
});

test("a SYN-ACK first orients the flow at its receiver", () => {
  const { r, out } = setup();
  r.push(seg(B, A, 500, "", TCPF_SYN | TCPF_ACK));
  r.push(seg(A, B, 101, "x"));
  assert.equal(out[0].dir, 1);
  assert.equal(out[0].sport, A.port);
});

test("out-of-order segments wait, retransmits are dropped, overlaps trimmed", () => {
  const { r, out, text } = setup();
  r.push(seg(A, B, 1000, "abc"));
  r.push(seg(A, B, 1006, "ghi")); /* early */
  assert.equal(text(1), "abc");
  r.push(seg(A, B, 1003, "def"));
  assert.equal(text(1), "abcdefghi");
  r.push(seg(A, B, 1003, "def")); /* retransmit */
  r.push(seg(A, B, 1007, "hijkl")); /* overlaps the tail */
  assert.equal(text(1), "abcdefghijkl");
  assert.equal(out.length, 4);
});

test("a segment that never arrives becomes a hole after holdMs", () => {
  const { r, out, text, tick } = setup({ holdMs: 100 });
  r.push(seg(A, B, 1, "abc"));
  r.push(seg(A, B, 10, "xyz"));
  tick(50);
  assert.equal(out.length, 1);
  tick(60);
  assert.equal(out.length, 3);
  assert.deepEqual([out[1].len, out[1].capLen], [6, 0], "6 bytes of hole");
  assert.equal(text(1), "abcxyz");
});

test("sequence numbers wrap", () => {
  const { r, text } = setup();
  r.push(seg(A, B, 0xfffffffe, "ab"));
  r.push(seg(A, B, 0, "cd"));
  assert.equal(text(1), "abcd");
});

test("FIN both ways closes the flow; RST closes at once; a new SYN reuses the port", () => {
  const { r, closed } = setup();
  r.push(seg(A, B, 1, "q", TCPF_ACK | TCPF_PSH | TCPF_FIN));
  r.push(seg(B, A, 1, "r"));
  assert.equal(closed.length, 0);
  r.push(seg(B, A, 2, "", TCPF_ACK | TCPF_FIN));
  assert.deepEqual(closed, [[flowKey(seg(A, B, 1)), "fin"]]);

  r.push(seg(A, B, 50, "again"));
  r.push(seg(B, A, 50, "", TCPF_RST));
  assert.equal(closed[1][1], "reset");

  r.push(seg(A, B, 70, "third"));
  r.push(seg(A, B, 9000, "", TCPF_SYN));
  assert.equal(closed[2][1], "reused");
  assert.equal(r.list().length, 1);
});

test("a short copy in a record is a hole the decoder is told about", () => {
  const { r, out } = setup();
  const s = seg(A, B, 1, "abcdef");
  s.capLen = 2;
  s.data = s.data.subarray(0, 2);
  r.push(s);
  r.push(seg(A, B, 7, "gh"));
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].len, out[0].capLen], [6, 2]);
  assert.equal(latin1(out[1].data), "gh");
});

test("wire → reassembler → decoder gives a transaction with both ends of the flow", () => {
  const txs = [];
  const d = new Decoder({ reorderMs: 0, onTransaction: (t) => txs.push(t) });
  const r = new Reassembler({ onRecord: (x) => d.push(x), onClose: (k, why) => d.close(connKeyOf(k), why) });
  r.push(seg(A, B, 10, "", TCPF_SYN));
  r.push(seg(B, A, 20, "", TCPF_SYN | TCPF_ACK));
  const res = "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello";
  /* Response body's second half delivered before its first. */
  r.push(seg(B, A, 21 + 30, res.slice(30)));
  r.push(seg(A, B, 11, "GET /x HTTP/1.1\r\nHost: h\r\n\r\n"));
  r.push(seg(B, A, 21, res.slice(0, 30)));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].role, "client");
  assert.equal(txs[0].target, "/x");
  assert.equal(latin1(txs[0].resBody.data), "hello");
  assert.equal(txs[0].flow.sport, A.port);
  assert.equal(txs[0].flow.dport, B.port);
  assert.ok(txs[0].complete);
  assert.equal(d.connections().length, 1);
  r.push(seg(A, B, 11 + 26, "", TCPF_ACK | TCPF_FIN));
  r.push(seg(B, A, 21 + res.length, "", TCPF_ACK | TCPF_FIN));
  assert.equal(r.list().length, 0);
  assert.equal(d.connections().length, 0, "the decoder's entry goes with the flow");
});
