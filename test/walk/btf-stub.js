/* A stand-in for `yeet:btf` over a few hand-written types, with the
 * same contract: type(name) / expand(id) / peel(id) / walk(struct, path)
 * — walk() descends anonymous members, crosses pointers as deref hops,
 * and reports bitfields as the daemon does. Offsets are invented; the
 * compiler must never assume any. */

const T = {
  1: { id: 1, kind: "struct", name: "sock", size: 776, members: [
    { name: "__sk_common", offset: 0, type: { id: 2, kind: "struct", name: "sock_common", size: 136 } },
    { name: "sk_rcvbuf", offset: 244, type: { id: 30, kind: "int", name: "int", size: 4 } },
    { name: "sk_dst_cache", offset: 552, type: { id: 20, kind: "ptr", size: 8 } },
    { name: "sk_socket", offset: 288, type: { id: 25, kind: "ptr", size: 8 } },
    { name: "sk_kind", offset: 700, type: { id: 80, kind: "enum", name: "sock_kind", size: 4 } },
    { name: "sk_v6_daddr", offset: 720, type: { id: 90, kind: "struct", name: "in6_addr", size: 16 } },
  ] },
  2: { id: 2, kind: "struct", name: "sock_common", size: 136, members: [
    { offset: 0, type: { id: 3, kind: "union", size: 8 } },
    { offset: 12, type: { id: 5, kind: "union", size: 4 } },
    { name: "skc_family", offset: 16, type: { id: 31, kind: "int", name: "short unsigned int", size: 2 } },
    { name: "skc_state", offset: 18, type: { id: 32, kind: "volatile" } },
    { name: "skc_reuse", offset: 19, bitfield: { bit_offset: 0, bit_size: 4 }, type: { id: 33, kind: "int", name: "unsigned char", size: 1 } },
    { name: "skc_prot", offset: 40, type: { id: 26, kind: "ptr", size: 8 } },
  ] },
  3: { id: 3, kind: "union", size: 8, members: [
    { name: "skc_addrpair", offset: 0, type: { id: 47, kind: "typedef", name: "__addrpair" } },
    { offset: 0, type: { id: 4, kind: "struct", size: 8 } },
  ] },
  4: { id: 4, kind: "struct", size: 8, members: [
    { name: "skc_daddr", offset: 0, type: { id: 40, kind: "typedef", name: "__be32" } },
    { name: "skc_rcv_saddr", offset: 4, type: { id: 40, kind: "typedef", name: "__be32" } },
  ] },
  5: { id: 5, kind: "union", size: 4, members: [
    { name: "skc_portpair", offset: 0, type: { id: 48, kind: "typedef", name: "__portpair" } },
    { offset: 0, type: { id: 6, kind: "struct", size: 4 } },
  ] },
  6: { id: 6, kind: "struct", size: 4, members: [
    { name: "skc_dport", offset: 0, type: { id: 41, kind: "typedef", name: "__be16" } },
    { name: "skc_num", offset: 2, type: { id: 42, kind: "typedef", name: "__u16" } },
  ] },
  10: { id: 10, kind: "struct", name: "tcp_sock", size: 2432, members: [
    { name: "snd_cwnd", offset: 1492, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "snd_nxt", offset: 1716, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "snd_una", offset: 1720, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "bytes_acked", offset: 1840, type: { id: 49, kind: "typedef", name: "u64" } },
    { name: "repair", offset: 1511, bitfield: { bit_offset: 0, bit_size: 1 }, type: { id: 51, kind: "typedef", name: "u8" } },
    { name: "tcp_usec_ts", offset: 1511, bitfield: { bit_offset: 1, bit_size: 1 }, type: { id: 51, kind: "typedef", name: "u8" } },
    { name: "rx_opt", offset: 1600, type: { id: 11, kind: "struct", name: "tcp_options_received", size: 24 } },
  ] },
  11: { id: 11, kind: "struct", name: "tcp_options_received", size: 24, members: [
    { name: "ts_recent", offset: 4, type: { id: 43, kind: "typedef", name: "u32" } },
  ] },
  20: { id: 20, kind: "ptr", size: 8, target: { id: 21, kind: "struct", name: "dst_entry", size: 200 } },
  21: { id: 21, kind: "struct", name: "dst_entry", size: 200, members: [
    { name: "dev", offset: 0, type: { id: 22, kind: "ptr", size: 8 } },
    { name: "next", offset: 8, type: { id: 20, kind: "ptr", size: 8 } },
  ] },
  22: { id: 22, kind: "ptr", size: 8, target: { id: 23, kind: "struct", name: "net_device", size: 2400 } },
  23: { id: 23, kind: "struct", name: "net_device", size: 2400, members: [
    { name: "name", offset: 288, type: { id: 24, kind: "array" } },
    { name: "mtu", offset: 400, type: { id: 44, kind: "int", name: "unsigned int", size: 4 } },
  ] },
  24: { id: 24, kind: "array", nelems: 16, elem: { id: 50, kind: "int", name: "char", size: 1 } },
  25: { id: 25, kind: "ptr", size: 8, target: { id: 27, kind: "struct", name: "socket", size: 100 } },
  26: { id: 26, kind: "ptr", size: 8, target: { id: 28, kind: "struct", name: "proto", size: 500 } },
  27: { id: 27, kind: "struct", name: "socket", size: 100, members: [{ name: "file", offset: 16, type: { id: 29, kind: "ptr", size: 8 } }] },
  28: { id: 28, kind: "struct", name: "proto", size: 500, members: [{ name: "name", offset: 392, type: { id: 24, kind: "array" } }] },
  29: { id: 29, kind: "ptr", size: 8, target: { id: 100, kind: "struct", name: "file", size: 300 } },
  100: { id: 100, kind: "struct", name: "file", size: 300, members: [{ name: "f_inode", offset: 32, type: { id: 101, kind: "ptr", size: 8 } }] },
  101: { id: 101, kind: "ptr", size: 8, target: { id: 102, kind: "struct", name: "inode", size: 600 } },
  102: { id: 102, kind: "struct", name: "inode", size: 600, members: [
    { name: "i_ino", offset: 64, type: { id: 45, kind: "int", name: "long long unsigned int", size: 8 } },
    { name: "i_sb", offset: 80, type: { id: 103, kind: "ptr", size: 8 } },
  ] },
  103: { id: 103, kind: "ptr", size: 8, target: { id: 104, kind: "struct", name: "super_block", size: 900 } },
  104: { id: 104, kind: "struct", name: "super_block", size: 900, members: [{ name: "s_bdev", offset: 100, type: { id: 105, kind: "ptr", size: 8 } }] },
  105: { id: 105, kind: "ptr", size: 8, target: { id: 106, kind: "struct", name: "block_device", size: 300 } },
  106: { id: 106, kind: "struct", name: "block_device", size: 300, members: [{ name: "bd_disk", offset: 40, type: { id: 107, kind: "ptr", size: 8 } }] },
  107: { id: 107, kind: "ptr", size: 8, target: { id: 108, kind: "struct", name: "gendisk", size: 300 } },
  108: { id: 108, kind: "struct", name: "gendisk", size: 300, members: [{ name: "major", offset: 0, type: { id: 30, kind: "int", name: "int", size: 4 } }, { name: "queue", offset: 100, type: { id: 109, kind: "ptr", size: 8 } }] },
  109: { id: 109, kind: "ptr", size: 8, target: { id: 110, kind: "struct", name: "request_queue", size: 300 } },
  110: { id: 110, kind: "struct", name: "request_queue", size: 300, members: [{ name: "nr_requests", offset: 8, type: { id: 44, kind: "int", name: "unsigned int", size: 4 } }] },
  30: { id: 30, kind: "int", name: "int", size: 4, encoding: { signed: true, char: false, bool: false } },
  31: { id: 31, kind: "int", name: "short unsigned int", size: 2, encoding: { signed: false, char: false, bool: false } },
  32: { id: 32, kind: "volatile", type: { id: 33 } },
  33: { id: 33, kind: "int", name: "unsigned char", size: 1, encoding: { signed: false, char: false, bool: false } },
  40: { id: 40, kind: "typedef", name: "__be32", type: { id: 44 } },
  41: { id: 41, kind: "typedef", name: "__be16", type: { id: 42 } },
  42: { id: 42, kind: "typedef", name: "__u16", type: { id: 31 } },
  43: { id: 43, kind: "typedef", name: "u32", type: { id: 44 } },
  44: { id: 44, kind: "int", name: "unsigned int", size: 4, encoding: { signed: false, char: false, bool: false } },
  45: { id: 45, kind: "int", name: "long long unsigned int", size: 8, encoding: { signed: false, char: false, bool: false } },
  47: { id: 47, kind: "typedef", name: "__addrpair", type: { id: 45 } },
  48: { id: 48, kind: "typedef", name: "__portpair", type: { id: 44 } },
  49: { id: 49, kind: "typedef", name: "u64", type: { id: 45 } },
  50: { id: 50, kind: "int", name: "char", size: 1, encoding: { signed: true, char: true, bool: false } },
  51: { id: 51, kind: "typedef", name: "u8", type: { id: 33 } },
  60: { id: 60, kind: "struct", name: "sk_buff", size: 232, members: [
    { name: "dev", offset: 16, type: { id: 22, kind: "ptr", size: 8 } },
    { name: "len", offset: 112, type: { id: 44, kind: "int", name: "unsigned int", size: 4 } },
    { name: "data", offset: 208, type: { id: 61, kind: "ptr", size: 8 } },
  ] },
  61: { id: 61, kind: "ptr", size: 8, target: { id: 33, kind: "int", name: "unsigned char", size: 1 } },
  70: { id: 70, kind: "struct", name: "inet_connection_sock", size: 1440, members: [
    { name: "icsk_rto", offset: 900, type: { id: 43, kind: "typedef", name: "u32" } },
    { name: "icsk_ca_state", offset: 1000, bitfield: { bit_offset: 0, bit_size: 5 }, type: { id: 51, kind: "typedef", name: "u8" } },
  ] },
  80: { id: 80, kind: "enum", name: "sock_kind", size: 4, values: [{ name: "SK_PLAIN", value: 0 }, { name: "SK_FANCY", value: 1 }] },
  90: { id: 90, kind: "struct", name: "in6_addr", size: 16, members: [] },
};

const byName = (name) => Object.values(T).find((t) => t.name === name && (t.kind === "struct" || t.kind === "union"));
const ref = (t) => ({ id: t.id, kind: t.kind, ...(t.name ? { name: t.name } : {}), ...(t.size != null ? { size: t.size } : {}) });

const fail = (code, message) => Object.assign(new Error(message), { code });

function peelId(id) {
  const typedefs = [];
  let t = T[id];
  while (t && (t.kind === "typedef" || t.kind === "volatile" || t.kind === "const")) {
    if (t.kind === "typedef") typedefs.push(t.name);
    t = T[t.type.id];
  }
  return { type: t, typedefs };
}

function locate(container, name) {
  for (const m of container.members ?? []) {
    if (m.name === name) return { member: m, byteOffset: m.offset };
    if (!m.name) {
      const inner = peelId(m.type.id).type;
      const found = inner && locate(inner, name);
      if (found) return { member: found.member, byteOffset: m.offset + found.byteOffset };
    }
  }
  return null;
}

export const calls = { walk: 0, type: 0, expand: 0, peel: 0 };

export const btf = {
  async type(name, { kind } = {}) {
    calls.type++;
    const t = Object.values(T).find((x) => x.name === name && (!kind || x.kind === kind));
    if (!t) throw fail("NO_TYPE", `No type named "${name}"`);
    return t;
  },
  async expand(target) {
    calls.expand++;
    const t = typeof target === "number" ? T[target] : byName(target);
    if (!t) throw fail("NO_TYPE", `No type ${target}`);
    return t;
  },
  async peel(target) {
    calls.peel++;
    const id = typeof target === "number" ? target : byName(target)?.id;
    const { type, typedefs } = peelId(id);
    if (!type) throw fail("NO_TYPE", `No type ${target}`);
    return { type, typedefs };
  },
  async walk(typeName, path) {
    calls.walk++;
    const start = byName(typeName);
    if (!start) throw fail("NO_TYPE", `No struct named "${typeName}"`);
    const segments = path.split(".").filter(Boolean);
    let container = start;
    let window = 0;
    const hops = [];
    let bitfield;
    let terminal = start;
    for (let i = 0; i < segments.length; i++) {
      const located = locate(container, segments[i]);
      if (!located) throw fail("NO_MEMBER", `Type "${container.name ?? "<anon>"}" has no member "${segments[i]}" in path "${path}" Available members: ${(container.members ?? []).map((m) => m.name).filter(Boolean).join(", ")}`);
      const field = peelId(located.member.type.id).type;
      const last = i === segments.length - 1;
      if (field.kind === "ptr" && !last) {
        hops.push({ op: "deref", at: window + located.byteOffset, width: 8 });
        window = 0;
        container = peelId(field.target.id).type;
      } else if (!last) {
        if (field.kind !== "struct" && field.kind !== "union") throw fail("NOT_COMPOSITE", `"${segments[i]}" in "${path}" is not a struct`);
        window += located.byteOffset;
        container = field;
      } else {
        terminal = field;
        const bf = located.member.bitfield;
        if (bf) {
          const width = field.size ?? 1;
          hops.push({ op: "load", at: window + located.byteOffset, width });
          bitfield = { bit_offset: bf.bit_offset, bit_size: bf.bit_size };
        } else {
          window += located.byteOffset;
          if (field.kind === "ptr" || field.kind === "int" || field.kind === "enum" || field.kind === "float") hops.push({ op: "load", at: window, width: field.size ?? 8 });
          else hops.push({ op: "field", at: window });
        }
      }
    }
    return { hops, type: ref(terminal), ...(bitfield ? { bitfield } : {}) };
  },
};
