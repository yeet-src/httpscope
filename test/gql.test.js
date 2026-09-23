import assert from "node:assert/strict";
import { test } from "node:test";

import { format, inlineMarkdown, pretty, rootsOf, tokenize, tokenizeJs } from "../app/lib/gql.js";

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

test("multi-line stage bodies keep their lines; JavaScript is tokenized, an ai body is prose", () => {
  const q = `{ endpoints { path n } }
| transform {
    // drop the quiet ones
    if ($.n < 5) return null;
    $.label = \`\${$.path}!\`;
}
| ai {
  For each endpoint:
  - say what it is **for**
  - flag anything odd in \`n\`
}`;
  const out = pretty(q);
  assert.equal(
    out,
    `{
  endpoints {
    path
    n
  }
}
| transform {
  // drop the quiet ones
  if ($.n < 5) return null;
  $.label = \`\${$.path}!\`;
}
| ai {
  For each endpoint:
  - say what it is **for**
  - flag anything odd in \`n\`
}`,
  );
  const types = format(q).map((t) => t.type);
  assert.ok(types.includes("js-comment") && types.includes("js-keyword") && types.includes("js-row") && types.includes("prose"));
  assert.deepEqual(tokenizeJs("if ($.n < 5) return null;").filter((t) => t.type !== "space").map((t) => t.type), ["js-keyword", "js-punct", "js-row", "js-punct", "js-ident", "js-punct", "js-number", "js-punct", "js-keyword", "js-keyword", "js-punct"]);
  const md = inlineMarkdown("- say what it is **for**\nflag `n`");
  assert.deepEqual(md.map((p) => p.kind), ["text", "text", "bold", "br", "text", "code"]);
});

test("rootsOf names the top-level fields", () => {
  assert.deepEqual(rootsOf('query Q($s: String!) { services(name: $s) { name } endpoints(where: { path: { like: "*" } }) { path } } | ai { x }'), ["services", "endpoints"]);
  assert.deepEqual(rootsOf("{ summary { transactions } }"), ["summary"]);
});

test("JSON tokens: keys, strings, numbers, literals", async () => {
  const { tokenizeJson } = await import("../app/lib/gql.js");
  const types = tokenizeJson('{"id": 390, "total": "13.50", "ok": true, "x": null}').filter((t) => t.type !== "space").map((t) => t.type);
  assert.deepEqual(types, ["json-punct", "json-key", "json-punct", "json-number", "json-punct", "json-key", "json-punct", "json-string", "json-punct", "json-key", "json-punct", "json-literal", "json-punct", "json-key", "json-punct", "json-literal", "json-punct"]);
});

test("path tokens colour segments, ids, placeholders and the query string", async () => {
  const { pathTokens } = await import("../app/lib/pathtokens.js");
  const toks = pathTokens("/api/v1/users/42/orders/{n}?page=2&q=x");
  assert.deepEqual(
    toks.map((t) => `${t.cls.replace("text-", "")}:${t.text}`),
    ["dim:/", "fg:api", "dim:/", "fg:v1", "dim:/", "fg:users", "dim:/", "yellow:42", "dim:/", "fg:orders", "dim:/", "magenta:{n}", "dim:?", "cyan:page", "dim:=", "green:2", "dim:&", "cyan:q", "dim:=", "green:x"],
  );
});
