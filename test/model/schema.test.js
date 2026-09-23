import assert from "node:assert/strict";
import { test } from "node:test";

import { describe, diff, merge, newSchema, observe } from "../../app/lib/model/schema.js";

const learn = (...values) => values.reduce((s, v) => observe(s, v), newSchema());

test("objects, optional keys, arrays and enums describe like types", () => {
  const s = learn(
    { id: 1, name: "a", tags: ["x"], kind: "user" },
    { id: 2, name: "b", tags: [], kind: "admin", meta: { deep: true } },
    { id: 3, name: "c", tags: ["y", "z"], kind: "user" },
    { id: 4, name: "d", tags: [], kind: "admin" },
  );
  const flat = describe(s).replace(/\s+/g, " ").replace(/\{ /g, "{ ").replace(/,? \}/g, " }");
  assert.equal(flat, '{ id: number, kind: "user" | "admin", name: string, tags: string[], meta?: { deep: boolean } }');
  assert.ok(describe(s).includes("\n"), "a long object breaks onto lines");
});

test("mixed types and nulls are unions; many strings are just string", () => {
  assert.equal(describe(learn(1, "a", null)), "number | string | null");
  const many = learn(...Array.from({ length: 40 }, (_, i) => `v${i}`));
  assert.equal(describe(many), "string");
  assert.equal(describe(learn([1, "a"])), "Array<number | string>");
  assert.equal(describe(learn({})), "{}");
});

test("diff reports added, missing and retyped fields once settled", () => {
  const s = newSchema();
  for (let i = 0; i < 10; i++) observe(s, { id: i, name: "n", nested: { a: 1 } });
  assert.deepEqual(diff(s, { id: 11, name: "n", nested: { a: 1 } }), []);
  const d = diff(s, { id: "eleven", nested: { a: 1, b: 2 }, extra: true });
  assert.deepEqual(
    d.map((e) => [e.kind, e.path]),
    [["type.changed", "$.id"], ["field.added", "$.nested.b"], ["field.added", "$.extra"], ["field.missing", "$.name"]],
  );
  assert.deepEqual(diff(newSchema(), { anything: 1 }), [], "an unsettled schema has no opinion");
});

test("merge folds one schema into another", () => {
  const a = learn({ x: 1 });
  const b = learn({ x: "s", y: 2 }, { x: 2 });
  merge(a, b);
  assert.equal(a.n, 3);
  assert.equal(describe(a), "{ x: number | string, y?: number }");
});
