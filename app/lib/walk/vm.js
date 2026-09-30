/* The walk VM's shape, as bpf/walk/walk.bpf.c defines it: op codes,
 * section limits, and the map value a field program is written as.
 * Pure — shared by the compiler, the decoder and the probe. */

export const MAX_FIELDS = 8;
export const MAX_STEP = 8; /* ops per pre[] / body[] section */
export const MAX_ITERS = 16;
export const ENTRY_CAP = 256; /* bytes per entry; a READ takes at most ENTRY_CAP - 1 */
export const MAX_READ = ENTRY_CAP - 1;
export const NREGS = 8;
export const NSCRATCH = 4;
export const REG_SOCK = 0;
export const REG_SKB = 1;
export const REG_PAYLOAD = 2; /* the segment's TCP payload, past the header */

export const WOP = { END: 0, BASE: 1, OFF: 2, DEREF: 3, READ: 4, STR: 5, VAL: 6, LOADN: 7, EQ: 8, SKIPZ: 9, SKIPNZ: 10, BACK: 11, STORE: 12, LOAD: 13, ADD: 14, SUB: 15 };
const NAMES = Object.fromEntries(Object.entries(WOP).map(([k, v]) => [v, k.toLowerCase()]));

export const op = (code, arg = 0) => ({ code, arg: arg >>> 0 });

/** One op as text, for a program listing: `off 552`, `deref`, `read 4`. */
export const opText = ({ code, arg }) => (arg ? `${NAMES[code] ?? code} ${arg}` : (NAMES[code] ?? String(code)));

const pad = (ops) => {
  const out = ops.slice(0, MAX_STEP).map((x) => ({ code: x.code | 0, arg: x.arg >>> 0 }));
  while (out.length < MAX_STEP) out.push({ code: 0, arg: 0 });
  return out;
};

/** A compiled field as the `programs` map value. */
export const program = (f) => ({
  n_pre: Math.min(f.pre.length, MAX_STEP),
  pre: pad(f.pre),
  next_off: (f.nextOff ?? 0) >>> 0,
  max_iters: Math.min(f.maxIters || 1, MAX_ITERS),
  n_body: Math.min(f.body.length, MAX_STEP),
  body: pad(f.body),
});
