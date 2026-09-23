import assert from "node:assert/strict";
import { test } from "node:test";

import { classify, parseTarget, valueKind } from "../../app/lib/model/path.js";

test("identifier-shaped segments are classified", () => {
  assert.equal(classify("42"), "{n}");
  assert.equal(classify("9f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b"), "{uuid}");
  assert.equal(classify("deadbeefcafebabe0123"), "{hex}");
  assert.equal(classify("2026-09-23"), "{date}");
  assert.equal(classify("a@b.co"), "{email}");
  assert.equal(classify("eyJhbGciOiJIUzI1NiJ9abc123"), "{token}");
  assert.equal(classify("users"), null);
  assert.equal(classify("data.json"), null);
  assert.equal(classify("v2"), null);
});

test("parseTarget templates the path and keeps the query", () => {
  const t = parseTarget("/api/v2/users/42/orders/9f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b?page=2&q=hello%20world&flag");
  assert.deepEqual(t.segments, ["api", "v2", "users", "{n}", "orders", "{uuid}"]);
  assert.deepEqual(t.literals, [null, null, null, "42", null, "9f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b"]);
  assert.deepEqual(t.query, [["page", "2"], ["q", "hello world"], ["flag", ""]]);
  assert.deepEqual(parseTarget("/").segments, []);
  assert.deepEqual(parseTarget("/a/b/").segments, ["a", "b"]);
  assert.deepEqual(parseTarget("http://example.com/x?y=1").segments, ["x"]);
  assert.deepEqual(parseTarget("*").segments, ["*"]);
});

test("query values have kinds", () => {
  assert.equal(valueKind("2"), "int");
  assert.equal(valueKind("2.5"), "number");
  assert.equal(valueKind("true"), "bool");
  assert.equal(valueKind("a,b"), "list");
  assert.equal(valueKind("hello"), "string");
  assert.equal(valueKind(""), "empty");
  assert.equal(valueKind("9f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b"), "uuid");
});
