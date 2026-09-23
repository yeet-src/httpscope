import assert from "node:assert/strict";
import { test } from "node:test";

import { bytesOfString, latin1 } from "../../app/lib/http/bytes.js";
import { H1Parser, REQUEST, RESPONSE, looksLike } from "../../app/lib/http/h1.js";

const collect = (kind, opts = {}) => {
  const ended = [];
  const desyncs = [];
  const p = new H1Parser(kind, { ...opts, onEnd: (m) => ended.push(m), onDesync: (w) => desyncs.push(w) });
  return { p, ended, desyncs };
};

const text = (m) => latin1(m.body.data());

test("request without a body ends at the blank line", () => {
  const { p, ended } = collect(REQUEST);
  p.push(bytesOfString("GET /a?b=1 HTTP/1.1\r\nHost: h\r\nX-Two: a\r\nX-Two: b\r\n\r\n"));
  assert.equal(ended.length, 1);
  const m = ended[0];
  assert.equal(m.method, "GET");
  assert.equal(m.target, "/a?b=1");
  assert.equal(m.version, "1.1");
  assert.deepEqual(m.headers, [["host", "h"], ["x-two", "a"], ["x-two", "b"]]);
  assert.equal(m.framing, "none");
  assert.ok(m.complete);
  assert.ok(p.idle);
});

test("content-length body, fed one byte at a time", () => {
  const { p, ended } = collect(RESPONSE);
  const wire = "HTTP/1.1 201 Created\r\nContent-Length: 5\r\n\r\nhelloHTTP/1.1 204 No Content\r\n\r\n";
  for (const ch of wire) p.push(bytesOfString(ch));
  assert.equal(ended.length, 2);
  assert.equal(ended[0].status, 201);
  assert.equal(ended[0].reason, "Created");
  assert.equal(text(ended[0]), "hello");
  assert.equal(ended[1].status, 204);
  assert.equal(ended[1].framing, "none");
});

test("chunked body with extension and trailers, de-chunked", () => {
  const { p, ended } = collect(RESPONSE);
  const wire = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nX-Sum: 1\r\n\r\n";
  for (let i = 0; i < wire.length; i += 3) p.push(bytesOfString(wire.slice(i, i + 3)));
  assert.equal(ended.length, 1);
  assert.equal(text(ended[0]), "hello world");
  assert.equal(ended[0].body.len, 11);
  assert.deepEqual(ended[0].trailers, [["x-sum", "1"]]);
  assert.ok(p.idle);
});

test("HEAD and 304 responses carry no body despite content-length", () => {
  let method = "HEAD";
  const { p, ended } = collect(RESPONSE, { methodOf: () => method });
  p.push(bytesOfString("HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n"));
  assert.equal(ended.length, 1);
  assert.equal(ended[0].framing, "none");
  method = "GET";
  p.push(bytesOfString("HTTP/1.1 304 Not Modified\r\nContent-Length: 999\r\n\r\n"));
  assert.equal(ended.length, 2);
  assert.ok(p.idle);
});

test("a response with neither length nor chunked runs to the close", () => {
  const { p, ended } = collect(RESPONSE);
  p.push(bytesOfString("HTTP/1.0 200 OK\r\n\r\nabc"));
  p.push(bytesOfString("def"));
  assert.equal(ended.length, 0);
  p.close();
  assert.equal(ended.length, 1);
  assert.equal(text(ended[0]), "abcdef");
  assert.ok(ended[0].complete);
});

test("a hole inside a body costs only the bytes", () => {
  const { p, ended, desyncs } = collect(RESPONSE);
  p.push(bytesOfString("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nab"));
  p.gap(6);
  p.push(bytesOfString("ijHTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
  assert.equal(desyncs.length, 0);
  assert.equal(ended.length, 2);
  assert.equal(ended[0].body.len, 10);
  assert.equal(ended[0].body.holes, 6);
  assert.equal(text(ended[0]), "abij");
});

test("a hole across a head loses the framing, and reset() recovers", () => {
  const { p, ended, desyncs } = collect(RESPONSE);
  p.push(bytesOfString("HTTP/1.1 200 OK\r\nContent-Le"));
  p.gap(100);
  assert.equal(desyncs.length, 1);
  assert.equal(p.state, "desync");
  p.push(bytesOfString("ignored while desynced"));
  assert.equal(ended.length, 0);
  p.reset();
  p.push(bytesOfString("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
  assert.equal(ended.length, 1);
});

test("garbage where a start line should be is a desync, not a throw", () => {
  const { p, desyncs } = collect(REQUEST);
  p.push(bytesOfString("\x16\x03\x01\x00\xf1\r\n\r\n"));
  assert.equal(desyncs.length, 1);
});

test("body capture is bounded but the count is not", () => {
  const { p, ended } = collect(RESPONSE, { bodyLimit: 4 });
  p.push(bytesOfString("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n12345678"));
  assert.equal(ended[0].body.len, 8);
  assert.equal(text(ended[0]), "1234");
  assert.ok(ended[0].body.truncated);
});

test("101 makes the rest of the direction opaque", () => {
  const opaque = [];
  const { p, ended } = collect(RESPONSE, { onOpaque: (m) => opaque.push(m) });
  p.push(bytesOfString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n\x81\x05hello"));
  assert.equal(ended.length, 1);
  assert.equal(opaque.length, 1);
  assert.equal(p.state, "opaque");
});

test("looksLike decides early and asks for more when it cannot", () => {
  assert.equal(looksLike(REQUEST, bytesOfString("GET /")), true);
  assert.equal(looksLike(REQUEST, bytesOfString("G")), null);
  assert.equal(looksLike(REQUEST, bytesOfString("\x16\x03")), false);
  assert.equal(looksLike(RESPONSE, bytesOfString("HTTP/1.1 200 OK")), true);
  assert.equal(looksLike(RESPONSE, bytesOfString("HTT")), null);
  assert.equal(looksLike(RESPONSE, bytesOfString("GET / HTTP/1.1")), false);
});
