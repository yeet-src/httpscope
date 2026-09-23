/* Records as the taps would deliver them, built from strings. */
import { bytesOfString } from "../../app/lib/http/bytes.js";

export const READ = 0;
export const WRITE = 1;

let ts = 1_000_000n;

/**
 * The records for one send/recv call of `text` on connection `conn`,
 * cut into segments of `seg` bytes as emit_data would, with the bytes
 * from `hole` on lost (a page that was not resident).
 */
export function call(dir, text, { conn = "0x1", pid = 42, transport = 0, seg = 4095, hole = null, flow = null } = {}) {
  const data = typeof text === "string" ? bytesOfString(text) : text;
  const len = data.length;
  const out = [];
  ts += 1000n;
  for (let off = 0; off < len; off += seg) {
    const end = Math.min(off + seg, len);
    let cap = end - off;
    if (hole != null && hole < end) cap = Math.max(0, hole - off);
    if (cap === 0 && off > 0) break;
    out.push({
      ts,
      at: Date.now(),
      conn,
      pid,
      tid: pid,
      len,
      off,
      capLen: cap,
      dir,
      transport,
      flags: 0,
      family: flow?.family ?? 0,
      sport: flow?.sport ?? 0,
      dport: flow?.dport ?? 0,
      saddr: flow?.saddr ?? null,
      daddr: flow?.daddr ?? null,
      data: data.subarray(off, off + cap),
    });
    if (hole != null && hole < end) break;
  }
  return out;
}

export const GET = (path = "/", extra = "") => `GET ${path} HTTP/1.1\r\nHost: example.test\r\n${extra}\r\n`;
export const OK = (body = "hello", extra = "") => `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`;
