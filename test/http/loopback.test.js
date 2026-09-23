/* The decoder against bytes a real HTTP client and server exchanged.
 *
 * Node's http module on loopback; the bytes are taken off the client
 * socket (what it wrote is DIR_WRITE, what arrived is DIR_READ) and
 * handed to the decoder as records, one per socket write or 'data'
 * event — which is roughly one per tcp_sendmsg/tcp_recvmsg. */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { latin1 } from "../../app/lib/http/bytes.js";
import { Decoder } from "../../app/lib/http/decoder.js";

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

test("node http client and server over loopback: chunked, json, keep-alive", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/json") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ got: body, n: 1 }));
      } else {
        /* No content-length set before write(): node chunks it. */
        res.write("part one, ");
        res.end("part two");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const txs = [];
  const d = new Decoder({ reorderMs: 0, onTransaction: (t) => txs.push(t) });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  agent.on("free", () => {});
  const tapped = new WeakSet();
  const tap = (socket) => {
    if (tapped.has(socket)) return;
    tapped.add(socket);
    const conn = "0x" + (socket.localPort ?? 0).toString(16);
    const write = socket.write.bind(socket);
    socket.write = (chunk, ...rest) => {
      d.push(record(1, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof rest[0] === "string" ? rest[0] : "utf8"), conn));
      return write(chunk, ...rest);
    };
    socket.on("data", (chunk) => d.push(record(0, chunk, conn)));
  };

  const request = (path, payload) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path, method: payload ? "POST" : "GET", agent }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(body));
      });
      req.on("socket", tap);
      req.on("error", reject);
      if (payload) req.setHeader("Content-Type", "application/json");
      req.end(payload);
    });

  const one = await request("/chunky");
  const two = await request("/json", JSON.stringify({ hello: "world" }));
  agent.destroy();
  await new Promise((r) => server.close(r));

  assert.equal(one, "part one, part two");
  assert.equal(two, JSON.stringify({ got: JSON.stringify({ hello: "world" }), n: 1 }));

  assert.equal(txs.length, 2, JSON.stringify(txs.map((t) => [t.target, t.status, t.cut])));
  assert.equal(txs[0].method, "GET");
  assert.equal(txs[0].target, "/chunky");
  assert.equal(txs[0].host, `127.0.0.1:${port}`);
  assert.equal(txs[0].role, "client");
  assert.equal(latin1(txs[0].resBody.data), "part one, part two");
  assert.ok(txs[0].complete);
  assert.equal(txs[1].method, "POST");
  assert.equal(latin1(txs[1].reqBody.data), JSON.stringify({ hello: "world" }));
  assert.equal(JSON.parse(latin1(txs[1].resBody.data)).n, 1);
  assert.ok(txs[1].complete);
});
