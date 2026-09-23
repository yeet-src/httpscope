/* The HTTP/2 layer against Node's own http2 module: a real h2c exchange
 * with HPACK, Huffman and a dynamic table, taken off the client socket
 * and fed to the decoder as records. */
import assert from "node:assert/strict";
import http2 from "node:http2";
import net from "node:net";
import { test } from "node:test";

import { bytesOfString, latin1 } from "../../app/lib/http/bytes.js";
import { Decoder } from "../../app/lib/http/decoder.js";
import { H2Connection, PREFACE } from "../../app/lib/http/h2.js";

const record = (dir, data, conn) => ({
  ts: process.hrtime.bigint(),
  at: Date.now(),
  conn,
  pid: process.pid,
  tid: process.pid,
  len: data.length,
  off: 0,
  capLen: data.length,
  dir,
  transport: 0,
  flags: 0,
  family: 2,
  sport: 1,
  dport: 2,
  saddr: "127.0.0.1",
  daddr: "127.0.0.1",
  data: new Uint8Array(data.buffer, data.byteOffset, data.length),
});

test("an h2c exchange through node's http2: requests, bodies, statuses, trailers", async () => {
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (c) => (body += c));
    stream.on("end", () => {
      const path = headers[":path"];
      if (path === "/missing") return stream.respond({ ":status": 404, "content-type": "application/json" }, { endStream: false }), stream.end('{"error":"nope"}');
      if (headers[":method"] === "POST") {
        stream.respond({ ":status": 201, "content-type": "application/json", "x-request-id": "abc123" });
        return stream.end(JSON.stringify({ got: JSON.parse(body), ok: true }));
      }
      stream.respond({ ":status": 200, "content-type": "application/json", "cache-control": "no-cache" }, { waitForTrailers: true });
      stream.on("wantTrailers", () => stream.sendTrailers({ "x-checksum": "deadbeef" }));
      stream.end(JSON.stringify({ path, users: [{ id: 1, name: "ada" }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const txs = [];
  const labels = [];
  const d = new Decoder({ reorderMs: 0, onTransaction: (t) => txs.push(t), onConnection: (c, e) => e === "label" && labels.push([c.proto, c.role, c.note]) });
  const conn = "0xh2";
  /* Node's http2 hands the socket to nghttp2 and bypasses JS writes, so
   * the bytes are taken at a relay in between — the wire, in effect. */
  const relay = net.createServer((client) => {
    const upstream = net.connect(port, "127.0.0.1");
    client.on("data", (chunk) => {
      d.push(record(1, chunk, conn));
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      d.push(record(0, chunk, conn));
      client.write(chunk);
    });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const relayPort = relay.address().port;
  const session = http2.connect(`http://127.0.0.1:${relayPort}`);
  const request = (headers, payload) =>
    new Promise((resolve, reject) => {
      const req = session.request(headers);
      let body = "";
      req.on("response", () => {});
      req.on("data", (c) => (body += c));
      req.on("end", () => resolve(body));
      req.on("error", reject);
      req.end(payload);
    });

  const one = await request({ ":method": "GET", ":path": "/users?page=2", "user-agent": "test/1" });
  const two = await request({ ":method": "POST", ":path": "/users", "content-type": "application/json" }, JSON.stringify({ name: "grace" }));
  const three = await request({ ":method": "GET", ":path": "/missing" });
  await new Promise((r) => session.close(r));
  await new Promise((r) => server.close(r));
  await new Promise((r) => relay.close(r));

  assert.equal(JSON.parse(one).path, "/users?page=2");
  assert.equal(JSON.parse(two).ok, true);
  assert.equal(three, '{"error":"nope"}');

  assert.deepEqual(labels[0], ["h2", "client", null]);
  assert.equal(txs.length, 3, JSON.stringify(txs.map((t) => [t.target, t.status, t.cut])));
  const [a, b, c] = txs;
  assert.deepEqual([a.proto, a.method, a.target, a.host, a.status], ["HTTP/2", "GET", "/users?page=2", `127.0.0.1:${relayPort}`, 200]);
  assert.deepEqual(JSON.parse(latin1(a.resBody.data)), { path: "/users?page=2", users: [{ id: 1, name: "ada" }] });
  assert.ok(a.resHeaders.some(([n, v]) => n === "cache-control" && v === "no-cache"));
  assert.ok(a.reqHeaders.some(([n, v]) => n === "user-agent" && v === "test/1"));
  assert.ok(a.complete);
  assert.equal(a.stream, 1);
  assert.deepEqual([b.method, b.status, latin1(b.reqBody.data)], ["POST", 201, '{"name":"grace"}']);
  assert.ok(b.resHeaders.some(([n, v]) => n === "x-request-id" && v === "abc123"));
  assert.deepEqual([c.status, latin1(c.resBody.data), c.complete], [404, '{"error":"nope"}', true]);
  assert.equal(d.connections()[0].proto, "h2");
});

test("a hole inside a DATA payload costs the body; a hole across a frame boundary loses the connection", () => {
  const frame = (type, flags, stream, payload) => {
    const h = new Uint8Array(9 + payload.length);
    h[0] = payload.length >> 16;
    h[1] = (payload.length >> 8) & 255;
    h[2] = payload.length & 255;
    h[3] = type;
    h[4] = flags;
    h[5] = (stream >>> 24) & 0x7f;
    h[6] = (stream >> 16) & 255;
    h[7] = (stream >> 8) & 255;
    h[8] = stream & 255;
    h.set(payload, 9);
    return h;
  };
  /* Literal headers without indexing: 0x00, then name and value as plain strings. */
  const lit = (n, v) => Uint8Array.from([0x00, n.length, ...bytesOfString(n), v.length, ...bytesOfString(v)]);
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) out.set(p, o), (o += p.length);
    return out;
  };
  const txs = [];
  const notes = [];
  const h2 = new H2Connection({ clientDir: 1, onTransaction: (t) => txs.push(t), onOpaque: (r) => notes.push(r) });
  h2.push(1, cat(bytesOfString(PREFACE), frame(4, 0, 0, new Uint8Array(0)), frame(1, 0x5, 1, cat(lit(":method", "GET"), lit(":path", "/big"), lit(":authority", "h")))), 1n);
  h2.push(0, cat(frame(4, 0, 0, new Uint8Array(0)), frame(1, 0x4, 1, lit(":status", "200"))), 2n);
  /* A 100-byte DATA frame: 40 bytes seen, 60 lost. */
  h2.push(0, cat(frame(0, 0x1, 1, new Uint8Array(100)).subarray(0, 9 + 40)), 3n);
  h2.gap(0, 60);
  assert.equal(txs.length, 1);
  assert.deepEqual([txs[0].req.method, txs[0].res.status, txs[0].res.body.len, txs[0].res.body.holes, txs[0].cut], ["GET", 200, 100, 60, null]);

  h2.push(1, frame(1, 0x5, 3, cat(lit(":method", "GET"), lit(":path", "/second"), lit(":authority", "h"))), 4n);
  h2.gap(0, 5);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /frame boundary/);
  assert.equal(txs.length, 2);
  assert.equal(txs[1].cut, "desync");
  assert.equal(txs[1].req.target, "/second");
});
