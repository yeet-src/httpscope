import assert from "node:assert/strict";
import { test } from "node:test";

import { pretty, tokenize } from "../app/lib/gql.js";

test("a one-line query formats one field per line with arguments inline and stages on their own lines", () => {
  const q = '{ endpoints(where: { service: { eq: "a" } }, limit: 3) { method path n errors: metric(name: ERRORS) @when(gt: 0) responses { status body { shape } } } } | transform { $.x = 1; } | ai { group them }';
  assert.equal(
    pretty(q),
    `{
  endpoints(where: { service: { eq: "a" } }, limit: 3) {
    method
    path
    n
    errors: metric(name: ERRORS) @when(gt: 0)
    responses {
      status
      body {
        shape
      }
    }
  }
}
| transform { $.x = 1; }
| ai { group them }`,
  );
});

test("tokens carry types the page colours", () => {
  const types = tokenize('query Q($s: String!) { services(name: $s) { name } } | ai { summarise }').filter((t) => t.type !== "space").map((t) => t.type);
  assert.deepEqual(types.slice(0, 8), ["keyword", "field", "punct", "punct", "variable", "punct", "value", "punct"]);
  assert.ok(types.includes("stage") && types.includes("code"));
});
