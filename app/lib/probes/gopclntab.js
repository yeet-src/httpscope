/* Go functions and their RET sites, read from the binary's own tables.
 *
 * A Go binary carries `.gopclntab`, the table its runtime unwinds and
 * prints tracebacks with. It survives every strip level (`-s -w` removes
 * .symtab and DWARF; the runtime cannot run without this), and it holds
 * two things the Go tap needs: where each function starts, and, per
 * function, the stack pointer delta at every PC. A `RET` is where that
 * delta returns to zero in the middle of the function — the epilogue
 * has just undone the prologue — so the return sites fall out of a
 * table walk with no disassembler at all. The byte at each candidate
 * is checked against the architecture's RET encoding to be sure.
 *
 * Pure: it works over a Uint8Array of the whole ELF and touches no
 * filesystem, so the host reads the file (Node) and this does the rest.
 * Supports the 1.18+ table layout (magic F0 and F1).
 */

const MAGIC_118 = 0xfffffff0;
const MAGIC_120 = 0xfffffff1;

const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(o) { return this.b[o]; }
  u16(o) { return this.dv.getUint16(o, true); }
  u32(o) { return this.dv.getUint32(o, true); }
  i32(o) { return this.dv.getInt32(o, true); }
  u64(o) { return Number(this.dv.getBigUint64(o, true)); }
  ptr(o, size) { return size === 8 ? this.u64(o) : this.u32(o); }

  /* LEB128, as Go's binary.Uvarint. Returns [value, nextOffset]. */
  uvarint(o) {
    let v = 0, shift = 0;
    for (;;) {
      const c = this.b[o++];
      v += (c & 0x7f) * 2 ** shift;
      if (c < 0x80) return [v, o];
      shift += 7;
    }
  }
  /* Zig-zag signed varint, as the pc tables use for value deltas. */
  varint(o) {
    const [u, next] = this.uvarint(o);
    return [u % 2 === 1 ? -(u + 1) / 2 : u / 2, next];
  }
  cstring(o) {
    let end = o;
    while (this.b[end]) end++;
    let s = "";
    for (let i = o; i < end; i++) s += String.fromCharCode(this.b[i]);
    return s;
  }
}

/* The ELF pieces this needs: machine, LOAD segments (to turn a virtual
 * address into a file offset), and the .gopclntab section. */
function elf(r) {
  if (r.u32(0) !== 0x464c457f) throw new Error("not an ELF file");
  if (r.u8(4) !== 2) throw new Error("only ELF64 is supported");
  const machine = r.u16(0x12);

  const phoff = r.u64(0x20), phentsize = r.u16(0x36), phnum = r.u16(0x38);
  const loads = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (r.u32(p) !== 1) continue; // PT_LOAD
    loads.push({ offset: r.u64(p + 8), vaddr: r.u64(p + 16), filesz: r.u64(p + 32) });
  }
  const fileOffset = (vaddr) => {
    const seg = loads.find((s) => vaddr >= s.vaddr && vaddr < s.vaddr + s.filesz);
    if (!seg) throw new Error(`address 0x${vaddr.toString(16)} is in no loaded segment`);
    return vaddr - seg.vaddr + seg.offset;
  };

  const shoff = r.u64(0x28), shentsize = r.u16(0x3a), shnum = r.u16(0x3c), shstrndx = r.u16(0x3e);
  const strtab = r.u64(shoff + shstrndx * shentsize + 24);
  const SHT_PROGBITS = 1, SHF_WRITE = 0x1, SHF_ALLOC = 0x2;
  let pclntab = null, text = null;
  const data = [];
  for (let i = 0; i < shnum; i++) {
    const s = shoff + i * shentsize;
    const name = r.cstring(strtab + r.u32(s));
    const section = { addr: r.u64(s + 16), offset: r.u64(s + 24), size: r.u64(s + 32) };
    /* `.gopclntab`, or `.data.rel.ro.gopclntab` where an older linker put
     * it for a position-independent build. */
    if (name.endsWith(".gopclntab")) pclntab = section;
    if (name === ".text") text = section;
    /* Initialised writable data (.data, .noptrdata, .go.module): where
     * runtime.moduledata lives. */
    const flags = r.u64(s + 8);
    if (r.u32(s + 4) === SHT_PROGBITS && (flags & SHF_WRITE) && (flags & SHF_ALLOC)) data.push(section);
  }
  if (!pclntab) throw new Error("no .gopclntab section — not a Go binary");
  return { machine, fileOffset, pclntab, text, data };
}

/**
 * Parse a Go ELF. Returns `{ machine, functions(), func(name) }` where
 * `func(name)` gives `{ name, entry, size, rets }` — `entry` the
 * function's file offset, `rets` the file offsets of its RET
 * instructions — or null if no such function.
 */
export function parseGo(bytes) {
  const r = new Reader(bytes);
  const { machine, fileOffset, pclntab, text, data } = elf(r);

  const base = pclntab.offset;
  const magic = r.u32(base);
  if (magic !== MAGIC_118 && magic !== MAGIC_120) {
    throw new Error(`unsupported pclntab magic 0x${magic.toString(16)} (need Go 1.18+)`);
  }
  const quantum = r.u8(base + 6);
  const ptrsize = r.u8(base + 7);
  const at = (i) => r.ptr(base + 8 + i * ptrsize, ptrsize);
  const nfunc = at(0);
  /* Entry offsets are relative to runtime.text. The header's field for
   * it is zero on go1.27, and the .text section only starts there when
   * no C objects precede it (a cgo binary puts them first), so the
   * runtime's own moduledata is the authority: its first word is the
   * address of this table, and minpc/text follow at fixed slots. */
  const moduledataText = () => {
    for (const sec of data) {
      for (let o = sec.offset; o + 23 * ptrsize <= sec.offset + sec.size; o += ptrsize) {
        if (r.ptr(o, ptrsize) !== pclntab.addr) continue;
        const minpc = r.ptr(o + 20 * ptrsize, ptrsize);
        const textField = r.ptr(o + 22 * ptrsize, ptrsize);
        if (minpc === textField && text && minpc >= text.addr && minpc < text.addr + text.size) return minpc;
      }
    }
    return 0;
  };
  const textStart = at(2) || moduledataText() || text?.addr || 0;
  const funcnames = base + at(3);
  const pctab = base + at(6);
  const functab = base + at(7);

  /* functab: nfunc pairs of (entryoff, funcoff) as u32, in entry order,
   * with one trailing entry holding the end of text. */
  const entries = [];
  for (let i = 0; i <= nfunc; i++) {
    entries.push({ entryoff: r.u32(functab + i * 8), funcoff: r.u32(functab + i * 8 + 4) });
  }

  const isRet = (fo) =>
    machine === EM_AARCH64 ? r.u32(fo) === 0xd65f03c0 : r.u8(fo) === 0xc3;

  /* The pcsp table for one function: (value, pc) deltas until a zero
   * value delta. Each segment [start, end) has one sp delta. */
  const spSegments = (pcsp, entry) => {
    const out = [];
    let o = pctab + pcsp, value = -1, pc = entry, first = true;
    for (;;) {
      const [dv, o1] = r.varint(o);
      if (dv === 0 && !first) break;
      first = false;
      const [dpc, o2] = r.uvarint(o1);
      value += dv;
      const start = pc;
      pc += dpc * quantum;
      out.push({ start, end: pc, value });
      o = o2;
    }
    return out;
  };

  const describe = (i) => {
    const f = functab + entries[i].funcoff;
    const name = r.cstring(funcnames + r.i32(f + 4));
    const entryAddr = textStart + entries[i].entryoff;
    const size = entries[i + 1].entryoff - entries[i].entryoff;
    const pcsp = r.u32(f + 16);
    const rets = [];
    if (pcsp) {
      const segs = spSegments(pcsp, entryAddr);
      for (let k = 1; k < segs.length; k++) {
        if (segs[k].value !== 0 || segs[k - 1].value === 0) continue;
        const fo = fileOffset(segs[k].start);
        if (isRet(fo)) rets.push(fo);
      }
    }
    return { name, entry: fileOffset(entryAddr), size, rets };
  };

  return {
    machine,
    arch: machine === EM_AARCH64 ? "arm64" : machine === EM_X86_64 ? "amd64" : `0x${machine.toString(16)}`,
    /** Every function's name, in text order. */
    *functions() {
      for (let i = 0; i < nfunc; i++) yield describe(i);
    },
    func(name) {
      for (let i = 0; i < nfunc; i++) {
        const f = functab + entries[i].funcoff;
        if (r.cstring(funcnames + r.i32(f + 4)) === name) return describe(i);
      }
      return null;
    },
  };
}

export const GO_TLS_WRITE = "crypto/tls.(*Conn).Write";
export const GO_TLS_READ = "crypto/tls.(*Conn).Read";

/**
 * What the Go taps need from a binary: file offsets for the two
 * boundary functions and the Read RET sites, or null for a non-Go ELF.
 *   { arch, write: { entry }, read: { entry, rets: [...] } }
 */
export function goTlsTargets(bytes) {
  let go;
  try {
    go = parseGo(bytes);
  } catch {
    return null;
  }
  const write = go.func(GO_TLS_WRITE);
  const read = go.func(GO_TLS_READ);
  if (!write && !read) return null;
  return {
    arch: go.arch,
    write: write && { entry: write.entry },
    read: read && { entry: read.entry, rets: read.rets },
  };
}
