/* The shape of JSON bodies, learned from samples.
 *
 * A schema is a running summary of every value seen at one place: which
 * types, and for objects which keys (each with its own schema and how
 * often it was present), for arrays the item schema, for primitives the
 * distinct values while there are few enough to be an enumeration.
 * `observe` merges one more value in; `diff` says what a value would
 * change before it is merged — that is what drift is made of; `describe`
 * prints it the way a person would write a type.
 *
 * Pure.
 */

const MAX_VALUES = 24;
const MAX_KEYS = 200;

export const newSchema = () => ({ n: 0, types: {}, keys: null, items: null, values: null, overflow: false });

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "object" ? "object" : typeof v);

/** Merge `value` into `schema`. */
export function observe(schema, value) {
  const t = typeOf(value);
  schema.n++;
  schema.types[t] = (schema.types[t] ?? 0) + 1;
  if (t === "object") {
    schema.keys ??= new Map();
    for (const k of Object.keys(value)) {
      let child = schema.keys.get(k);
      if (!child) {
        if (schema.keys.size >= MAX_KEYS) {
          schema.overflow = true;
          continue;
        }
        child = newSchema();
        schema.keys.set(k, child);
      }
      observe(child, value[k]);
    }
  } else if (t === "array") {
    schema.items ??= newSchema();
    for (const item of value) observe(schema.items, item);
  } else if (t !== "undefined") {
    if (!schema.overflow) {
      schema.values ??= new Set();
      schema.values.add(t === "string" ? JSON.stringify(value) : String(value));
      if (schema.values.size > MAX_VALUES) {
        schema.values = null;
        schema.overflow = true;
      }
    }
  }
  return schema;
}

/**
 * What observing `value` would change, once the schema is settled
 * (`schema.n >= minSamples`): `[{ kind, path, detail }]` with kinds
 * `field.added`, `field.missing` (a key present in every sample so far
 * is absent), `type.changed` (a type never seen at this path).
 */
export function diff(schema, value, { minSamples = 10, path = "$" } = {}) {
  const out = [];
  walk(schema, value, path, minSamples, out);
  return out;
}

function walk(schema, value, path, min, out) {
  if (!schema || schema.n < min) return;
  const t = typeOf(value);
  if (!schema.types[t]) {
    out.push({ kind: "type.changed", path, detail: `${t} where ${Object.keys(schema.types).join("|")} was` });
    return;
  }
  if (t === "object" && schema.keys) {
    const present = schema.types.object;
    for (const k of Object.keys(value)) {
      const child = schema.keys.get(k);
      if (!child) {
        if (!schema.overflow) out.push({ kind: "field.added", path: `${path}.${k}`, detail: describe(observe(newSchema(), value[k])) });
        continue;
      }
      walk(child, value[k], `${path}.${k}`, min, out);
    }
    for (const [k, child] of schema.keys) {
      if (child.n >= present && child.n >= min && !(k in value)) out.push({ kind: "field.missing", path: `${path}.${k}`, detail: `was in all ${child.n} samples` });
    }
  } else if (t === "array" && schema.items) {
    for (const item of value.slice(0, 8)) walk(schema.items, item, `${path}[]`, min, out);
  }
}

/** Fold `b` into `a`. */
export function merge(a, b) {
  if (!b) return a;
  a.n += b.n;
  for (const [t, n] of Object.entries(b.types)) a.types[t] = (a.types[t] ?? 0) + n;
  if (b.keys) {
    a.keys ??= new Map();
    for (const [k, child] of b.keys) {
      if (a.keys.has(k)) merge(a.keys.get(k), child);
      else if (a.keys.size < MAX_KEYS) a.keys.set(k, child);
      else a.overflow = true;
    }
  }
  if (b.items) {
    if (a.items) merge(a.items, b.items);
    else a.items = b.items;
  }
  if (b.overflow) {
    a.overflow = true;
    a.values = null;
  } else if (b.values && !a.overflow) {
    a.values ??= new Set();
    for (const v of b.values) a.values.add(v);
    if (a.values.size > MAX_VALUES) {
      a.values = null;
      a.overflow = true;
    }
  }
  return a;
}

/**
 * The schema as a type: `{ id: number, name: string, tags?: string[] }`.
 * A key is optional when it was absent from some sample. Few distinct
 * primitives print as an enumeration. Nested objects break onto lines
 * when they get long.
 */
export function describe(schema, indent = "") {
  if (!schema || schema.n === 0) return "unknown";
  const parts = [];
  const types = Object.entries(schema.types).sort((x, y) => y[1] - x[1]);
  for (const [t] of types) {
    if (t === "object") parts.push(describeObject(schema, indent));
    else if (t === "array") parts.push(describeArray(schema, indent));
    else if (t === "null") parts.push("null");
    else if (t === "string" && isEnum(schema, types)) parts.push([...schema.values].join(" | "));
    else parts.push(t);
  }
  return parts.join(" | ");
}

/* Few distinct strings, each seen more than once on average: a set of
 * names rather than free text. Numbers are never enumerated — ids look
 * like enums until they don't. */
const isEnum = (schema, types) =>
  types.length === 1 && schema.values && !schema.overflow && schema.values.size <= 6 && schema.n >= Math.max(3, 2 * schema.values.size);

function describeObject(schema, indent) {
  if (!schema.keys || schema.keys.size === 0) return "{}";
  const present = schema.types.object;
  const fields = [];
  for (const [k, child] of [...schema.keys].sort((x, y) => y[1].n - x[1].n || (x[0] < y[0] ? -1 : 1))) {
    const opt = child.n < present ? "?" : "";
    fields.push(`${key(k)}${opt}: ${describe(child, indent + "  ")}`);
  }
  if (schema.overflow) fields.push("…");
  const one = `{ ${fields.join(", ")} }`;
  if (one.length <= 72 && !one.includes("\n")) return one;
  return `{\n${fields.map((f) => `${indent}  ${f}`).join(",\n")}\n${indent}}`;
}

function describeArray(schema, indent) {
  if (!schema.items || schema.items.n === 0) return "[]";
  const inner = describe(schema.items, indent);
  return inner.includes(" | ") || inner.includes("\n") ? `Array<${inner}>` : `${inner}[]`;
}

const key = (k) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));

/** A plain-object form that survives JSON, for the API. */
export function toJSON(schema) {
  if (!schema) return null;
  return {
    n: schema.n,
    types: schema.types,
    keys: schema.keys ? Object.fromEntries([...schema.keys].map(([k, v]) => [k, toJSON(v)])) : undefined,
    items: schema.items ? toJSON(schema.items) : undefined,
    values: schema.values ? [...schema.values] : undefined,
    overflow: schema.overflow || undefined,
  };
}
