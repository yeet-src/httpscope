/* Filling payload windows the kernel could not read from the wire tap's
 * copy of the same packet.
 *
 * A walk row is the receiver's view of a segment; its skb often holds
 * only headers in the linear area (page fragments carry the payload,
 * on loopback and on drivers that split headers), so a payload window
 * comes back empty. The wire tap saw that packet cross a device with
 * its bytes; the two are the same segment when the packet's source is
 * the row's peer, its destination the row's own end, and the sequence
 * numbers agree. Pure: `lookup(key)` is the ring of recent wire
 * records, keyed by `wireKey`.
 */

import { decodeEntry } from "./decode.js";

/** The key a wire record files under: packet src → dst, sequence number. */
export const wireKey = (saddr, sport, daddr, dport, seq) => `${saddr}:${sport}>${daddr}:${dport}#${seq >>> 0}`;

/** The key a walk row's segment would have on the wire. */
export const rowKey = (row) => wireKey(row.daddr, row.dport, row.saddr, row.sport, row.seq);

/**
 * For each field that is a payload window, fill rows whose value is
 * null from `lookup(rowKey(row))` — a Uint8Array of the packet's
 * payload from its first byte — when the window falls within it.
 * Returns how many windows were filled.
 */
export function fillPayloads(rows, fields, lookup) {
  const windows = fields.filter((f) => f.decode?.payload != null);
  if (!windows.length) return 0;
  let filled = 0;
  for (const row of rows) {
    let data;
    for (const f of windows) {
      if (row.values[f.name] != null) continue;
      data ??= lookup(rowKey(row)) ?? null;
      if (!data) break;
      const offset = f.decode.payload;
      if (offset >= data.length) continue;
      const slice = data.subarray(offset, Math.min(data.length, offset + f.decode.size));
      row.values[f.name] = decodeEntry(slice, slice.length, f.decode);
      filled++;
    }
  }
  return filled;
}
