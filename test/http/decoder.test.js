import assert from "node:assert/strict";
import { test } from "node:test";

import { latin1 } from "../../app/lib/http/bytes.js";
import { Decoder } from "../../app/lib/http/decoder.js";
import { GET, OK, READ, WRITE, call } from "./fixtures.js";

const setup = (opts = {}) => {
  const txs = [];
  const events = [];
  const d = new Decoder({ reorderMs: 0, ...opts, onTransaction: (t) => txs.push(t), onConnection: (c, e) => events.push([e, c.proto, c.role]) });
  const feed = (records) => records.forEach((r) => d.push(r));
  return { d, txs, events, feed };
};

const body = (b) => latin1(b.data);

test("a client: request written, response read, paired into one transaction", () => {
  const { d, txs, feed } = setup();
  feed(call(WRITE, GET("/x", "User-Agent: t\r\n")));
  feed(call(READ, OK("hi")));
  assert.equal(txs.length, 1);
  const t = txs[0];
  assert.equal(t.role, "client");
  assert.equal(t.method, "GET");
  assert.equal(t.target, "/x");
  assert.equal(t.host, "example.test");
  assert.equal(t.status, 200);
  assert.equal(body(t.resBody), "hi");
  assert.equal(t.proto, "HTTP/1.1");
  assert.ok(t.complete);
  assert.equal(typeof t.durationNs, "bigint");
  assert.ok(t.durationNs > 0n);
  assert.equal(d.connections()[0].transactions, 1);
});

test("a server: request read, response written", () => {
  const { txs, feed } = setup();
  feed(call(READ, "POST /submit HTTP/1.1\r\nHost: s\r\nContent-Length: 3\r\n\r\nabc"));
  feed(call(WRITE, OK("done")));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].role, "server");
  assert.equal(txs[0].method, "POST");
  assert.equal(body(txs[0].reqBody), "abc");
  assert.equal(txs[0].status, 200);
});

test("keep-alive and pipelining pair in order", () => {
  const { txs, feed } = setup();
  feed(call(WRITE, GET("/1") + GET("/2")));
  feed(call(READ, OK("one")));
  feed(call(WRITE, GET("/3")));
  feed(call(READ, OK("two") + OK("three")));
  assert.deepEqual(
    txs.map((t) => [t.target, body(t.resBody)]),
    [["/1", "one"], ["/2", "two"], ["/3", "three"]],
  );
});

test("100-continue is recorded as interim, not as the response", () => {
  const { txs, feed } = setup();
  feed(call(WRITE, "PUT /u HTTP/1.1\r\nHost: h\r\nExpect: 100-continue\r\nContent-Length: 2\r\n\r\n"));
  feed(call(READ, "HTTP/1.1 100 Continue\r\n\r\n"));
  feed(call(WRITE, "ok"));
  feed(call(READ, OK("")));
  assert.equal(txs.length, 1);
  assert.deepEqual(txs[0].interim, [100]);
  assert.equal(txs[0].status, 200);
  assert.equal(body(txs[0].reqBody), "ok");
});

test("segments of one call reassemble; a hole in the body is accounted", () => {
  const { txs, feed } = setup();
  const big = "x".repeat(10000);
  feed(call(WRITE, GET("/big")));
  feed(call(READ, OK(big), { seg: 4095 }));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].resBody.len, 10000);
  assert.equal(txs[0].resBody.holes, 0);

  feed(call(WRITE, GET("/holey")));
  feed(call(READ, OK(big), { seg: 4095, hole: 6000 }));
  /* The next call closes out the hole. */
  feed(call(WRITE, GET("/after")));
  feed(call(READ, OK("z")));
  assert.equal(txs.length, 3);
  assert.equal(txs[1].target, "/holey");
  assert.equal(txs[1].resBody.len, 10000);
  assert.ok(txs[1].resBody.holes > 0);
  assert.ok(txs[1].complete);
  assert.equal(txs[2].target, "/after");
  assert.equal(body(txs[2].resBody), "z");
});

test("a hole through a head desyncs, flushes in flight, and resyncs at the next call", () => {
  const { d, txs, feed } = setup();
  feed(call(WRITE, GET("/lost")));
  feed(call(READ, OK("hello"), { hole: 10 }));
  feed(call(WRITE, GET("/next")));
  feed(call(READ, OK("fine")));
  assert.equal(txs.length, 2);
  assert.equal(txs[0].target, "/lost");
  assert.equal(txs[0].complete, false);
  assert.equal(txs[0].cut, "desync");
  assert.equal(txs[1].target, "/next");
  assert.ok(txs[1].complete);
  assert.match(d.connections()[0].note, /desync/);
});

test("joining mid-response: the tail is skipped, the next request starts clean", () => {
  const { txs, feed } = setup();
  feed(call(READ, "...tail of a body we never saw the head of..."));
  feed(call(WRITE, GET("/fresh")));
  feed(call(READ, OK("ok")));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].target, "/fresh");
  assert.ok(txs[0].complete);
});

test("an HTTP/2 preface and a TLS record are labelled, not parsed", () => {
  const { d, feed } = setup();
  feed(call(WRITE, "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n\x00\x00\x12\x04\x00", { conn: "0xa" }));
  feed(call(WRITE, "\x16\x03\x01\x02\x00\x01\x00\x01\xfc\x03\x03", { conn: "0xb" }));
  feed(call(READ, "\x17\x03\x03\x00\x45\x8a\x11", { conn: "0xc" }), "application data mid-stream");
  const rows = d.connections();
  assert.deepEqual(rows.map((r) => [r.proto, r.role]), [["h2", "client"], ["tls", null], ["tls", null]]);
});

test("a struct sock reused for a new 4-tuple starts a new connection", () => {
  const { d, txs, events, feed } = setup();
  const a = { family: 2, saddr: "10.0.0.1", sport: 40000, daddr: "10.0.0.2", dport: 80 };
  const b = { ...a, sport: 40001 };
  feed(call(WRITE, GET("/a"), { flow: a }));
  feed(call(READ, "HTTP/1.1 200 OK\r\n\r\npartial", { flow: a }));
  feed(call(WRITE, GET("/b"), { flow: b }));
  feed(call(READ, OK("b"), { flow: b }));
  assert.equal(txs.length, 2);
  assert.equal(txs[0].target, "/a");
  assert.ok(txs[0].complete, "an until-close body completes when the socket is reused");
  assert.equal(body(txs[0].resBody), "partial");
  assert.equal(txs[1].target, "/b");
  assert.equal(d.connections().length, 1);
  assert.ok(events.some(([e]) => e === "close"));
});

test("close() finishes an until-close body and cuts the rest", () => {
  const { d, txs, feed } = setup();
  feed(call(WRITE, GET("/a") + GET("/b")));
  feed(call(READ, "HTTP/1.1 200 OK\r\n\r\nall of it"));
  d.close("42:0:0x1");
  assert.equal(txs.length, 2);
  assert.ok(txs[0].complete);
  assert.equal(body(txs[0].resBody), "all of it");
  assert.equal(txs[1].complete, false);
  assert.equal(txs[1].status, null);
  assert.equal(d.connections().length, 0);
});

test("sweep() drops idle connections and reports their in-flight requests", () => {
  let now = 1000;
  const { d, txs, feed } = setup({ now: () => now });
  feed(call(WRITE, GET("/slow")));
  now += 5000;
  feed(call(WRITE, GET("/fresh"), { conn: "0x2" }));
  assert.equal(d.sweep(3000), 1);
  assert.equal(txs.length, 1);
  assert.equal(txs[0].cut, "idle");
  assert.equal(d.connections().length, 1);
});

test("a TLS tap's connection gets its flow from a peer event", () => {
  const { d, txs, feed } = setup();
  feed(call(WRITE, GET("/secure"), { transport: 1, conn: "0x55" }));
  d.peer({ pid: 42, conn: "0x55", sk: "0x99", family: 2, saddr: "10.0.0.1", sport: 5555, daddr: "1.2.3.4", dport: 443 });
  feed(call(READ, OK("s"), { transport: 1, conn: "0x55" }));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].transport, 1);
  assert.equal(txs[0].flow.dport, 443);
});

test("a response with no request seen is an orphan transaction", () => {
  const { txs, feed } = setup();
  feed(call(READ, OK("orphan")));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].method, null);
  assert.equal(txs[0].status, 200);
  assert.equal(txs[0].cut, "no request");
  assert.equal(txs[0].role, "client");
});

test("a websocket upgrade ends decoding on that connection", () => {
  const { d, txs, feed } = setup();
  feed(call(WRITE, GET("/ws", "Upgrade: websocket\r\nConnection: Upgrade\r\n")));
  feed(call(READ, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"));
  feed(call(READ, "\x81\x05hello"));
  feed(call(WRITE, "\x81\x85\x00\x00\x00\x00hello"));
  assert.equal(txs.length, 1);
  assert.equal(txs[0].status, 101);
  assert.equal(d.connections()[0].proto, "other");
  assert.match(d.connections()[0].note, /websocket/);
});

test("records delivered out of timestamp order are fed in order", () => {
  let now = 1000;
  const { txs, feed, d } = setup({ reorderMs: 5, now: () => now });
  const req = call(WRITE, GET("/r"));
  const head = call(READ, "HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n");
  const bodyRec = call(READ, "abcd");
  /* Body first, as the loader sometimes hands them over. */
  feed(req);
  feed(bodyRec);
  feed(head);
  assert.equal(txs.length, 0, "held: nothing is 5ms behind yet");
  now += 6;
  d.tick();
  assert.equal(txs.length, 1);
  assert.equal(txs[0].status, 200);
  assert.equal(body(txs[0].resBody), "abcd");
  assert.ok(txs[0].complete);
});

test("a peek read is not new bytes", () => {
  const { txs, feed } = setup();
  feed(call(WRITE, GET("/p")));
  const peek = call(READ, OK("x"));
  peek.forEach((r) => (r.flags = 0x42));
  feed(peek);
  feed(call(READ, OK("x")));
  assert.equal(txs.length, 1);
  assert.equal(body(txs[0].resBody), "x");
});

test("a reused struct sock while records are held does not split the new connection", () => {
  let now = 1000;
  const { txs, feed, d } = setup({ reorderMs: 5, now: () => now });
  const a = { family: 2, saddr: "10.0.0.2", sport: 8089, daddr: "10.0.0.1", dport: 40000 };
  const b = { ...a, dport: 40001 };
  /* A server: first connection done and closed by the peer. */
  feed(call(READ, GET("/1"), { flow: a }));
  feed(call(WRITE, OK("one"), { flow: a }));
  /* The next connection lands on the same struct sock. Its request and
   * response are both in the window when the reuse is noticed. */
  feed(call(READ, "POST /post HTTP/1.1\r\nHost: h\r\nContent-Length: 7\r\n\r\n{\"a\":1}", { flow: b }));
  feed(call(WRITE, "HTTP/1.1 501 Nope\r\nContent-Length: 0\r\n\r\n", { flow: b }));
  now += 6;
  d.tick();
  assert.deepEqual(
    txs.map((t) => [t.method, t.status, t.complete, t.cut]),
    [["GET", 200, true, null], ["POST", 501, true, null]],
  );
  assert.equal(d.connections().length, 1);
  assert.equal(d.connections()[0].inflight, 0);
});
