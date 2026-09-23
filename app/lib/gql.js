/* A GraphQL query as the page shows it: formatted over lines and cut
 * into coloured tokens. Covers what agents send here — a document, then
 * optional `| context/transform/ai { … }` stages — with a tokenizer, not
 * a parser, so a malformed query still renders. Pure. */

const PUNCT = new Set(["{", "}", "(", ")", "[", "]", ":", ",", "=", "!", "|", "$", "@", "..."]);
const KEYWORDS = new Set(["query", "mutation", "subscription", "fragment", "on", "true", "false", "null"]);

/** `[{ type, text }]` — types: keyword, name, arg, field, directive, string, number, punct, variable, comment, stage, code, space. */
export function tokenize(source) {
  const out = [];
  let i = 0;
  const s = String(source ?? "");
  const push = (type, text) => text && out.push({ type, text });
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      push("space", s.slice(i, j));
      i = j;
      continue;
    }
    if (c === "#") {
      let j = i;
      while (j < s.length && s[j] !== "\n") j++;
      push("comment", s.slice(i, j));
      i = j;
      continue;
    }
    /* A pipeline stage: `| name { body }` — the body is code or prose, one token. */
    if (c === "|") {
      const m = /^\|\s*(context|transform|ai)\s*\{/.exec(s.slice(i));
      if (m) {
        push("punct", "|");
        push("space", m[0].slice(1, m[0].length - m[1].length - 1).replace(/\s*$/, "") || " ");
        push("stage", m[1]);
        const after = s.slice(i + m[0].length - 1);
        push("space", m[0].slice(1 + m[1].length + (m[0].slice(1).indexOf(m[1]))).replace(/\{$/, "") || "");
        push("punct", "{");
        let depth = 1;
        let j = 1;
        for (; j < after.length && depth > 0; j++) {
          if (after[j] === "{") depth++;
          else if (after[j] === "}") depth--;
        }
        const body = after.slice(1, depth === 0 ? j - 1 : j);
        push("code", body);
        if (depth === 0) push("punct", "}");
        i += m[0].length - 1 + (depth === 0 ? j : after.length);
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      if (s.startsWith('"""', i)) {
        j = s.indexOf('"""', i + 3);
        j = j < 0 ? s.length : j + 3;
      } else {
        while (j < s.length && s[j] !== '"') {
          if (s[j] === "\\") j++;
          j++;
        }
        j = Math.min(j + 1, s.length);
      }
      push("string", s.slice(i, j));
      i = j;
      continue;
    }
    if (s.startsWith("...", i)) {
      push("punct", "...");
      i += 3;
      continue;
    }
    if (PUNCT.has(c)) {
      push("punct", c);
      i++;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.eE+-]/.test(s[j])) j++;
      push("number", s.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const prev = lastSignificant(out);
      let type = "field";
      if (KEYWORDS.has(word) && !(prev?.type === "punct" && prev.text === ":")) type = "keyword";
      else if (prev?.type === "punct" && prev.text === "@") type = "directive";
      else if (prev?.type === "punct" && prev.text === "$") type = "variable";
      else if (nextSignificantChar(s, j) === ":") type = "arg";
      else if (prev?.type === "punct" && prev.text === ":") type = "value";
      push(type, word);
      i = j;
      continue;
    }
    push("punct", c);
    i++;
  }
  return out;
}

const lastSignificant = (tokens) => {
  for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].type !== "space" && tokens[k].type !== "comment") return tokens[k];
  return null;
};
const nextSignificantChar = (s, j) => {
  while (j < s.length && /\s/.test(s[j])) j++;
  return s[j] ?? "";
};

/**
 * Re-flow tokens: one field per line inside selection sets, arguments
 * inline, two-space indent, and each pipeline stage on its own line
 * with its body as written. Returns tokens (whitespace rewritten).
 */
export function format(source) {
  const tokens = tokenize(source).filter((t) => t.type !== "space");
  const out = [];
  let depth = 0; /* selection-set depth */
  let parens = 0; /* inside ( ) or [ ]: stay inline */
  let lineStart = true;
  const nl = () => {
    out.push({ type: "space", text: "\n" + "  ".repeat(depth) });
    lineStart = true;
  };
  const sp = () => {
    if (!lineStart && out.length && !/\s$/.test(out[out.length - 1].text)) out.push({ type: "space", text: " " });
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (t.type === "punct" && (t.text === "(" || t.text === "[")) {
      if (t.text === "[") sp();
      out.push(t);
      parens++;
      lineStart = false;
      continue;
    }
    if (t.type === "punct" && (t.text === ")" || t.text === "]")) {
      parens = Math.max(0, parens - 1);
      out.push(t);
      lineStart = false;
      continue;
    }
    if (parens > 0) {
      /* inline: `name: value, name: value` */
      if (t.type === "punct" && (t.text === ":" || t.text === "," || t.text === "!")) out.push(t);
      else if (prev && prev.type === "punct" && (prev.text === "(" || prev.text === "[" || prev.text === "$" || prev.text === "@")) out.push(t);
      else if (t.type === "punct" && t.text === "{") {
        sp();
        out.push(t);
      } else if (t.type === "punct" && t.text === "}") out.push({ type: "space", text: " " }, t);
      else if (prev && prev.type === "punct" && prev.text === "{") out.push({ type: "space", text: " " }, t);
      else {
        sp();
        out.push(t);
      }
      lineStart = false;
      continue;
    }
    if (t.type === "punct" && t.text === "{") {
      sp();
      out.push(t);
      depth++;
      if (next && !(next.type === "punct" && next.text === "}")) nl();
      continue;
    }
    if (t.type === "punct" && t.text === "}") {
      depth = Math.max(0, depth - 1);
      if (!lineStart) nl();
      out.push(t);
      lineStart = false;
      if (next && !(next.type === "punct" && (next.text === "}" || next.text === "|"))) nl();
      continue;
    }
    /* `| stage { body }` on a line of its own, the body as written but
     * trimmed, however many lines it spans. */
    if (t.type === "punct" && t.text === "|" && next?.type === "stage") {
      depth = 0;
      out.push({ type: "space", text: "\n" }, t, { type: "space", text: " " }, next);
      k++;
      if (tokens[k + 1]?.type === "punct" && tokens[k + 1].text === "{") {
        k++;
        out.push({ type: "space", text: " " }, tokens[k]);
        if (tokens[k + 1]?.type === "code") {
          k++;
          const body = tokens[k].text.trim();
          out.push({ type: "space", text: body.includes("\n") ? "\n  " : " " }, { type: "code", text: body.replace(/\n/g, "\n  ") }, { type: "space", text: body.includes("\n") ? "\n" : " " });
        }
        if (tokens[k + 1]?.type === "punct" && tokens[k + 1].text === "}") {
          k++;
          out.push(tokens[k]);
        }
      }
      lineStart = false;
      continue;
    }
    if (t.type === "punct" && t.text === "@") {
      sp();
      out.push(t);
      lineStart = false;
      continue;
    }
    if (t.type === "punct" && (t.text === ":" || t.text === "!" || t.text === "$" || t.text === ",")) {
      out.push(t);
      lineStart = false;
      continue;
    }
    if (prev && prev.type === "punct" && (prev.text === "@" || prev.text === "$")) {
      out.push(t);
      lineStart = false;
      continue;
    }
    if (prev && prev.type === "punct" && prev.text === ":") {
      /* `alias: field` */
      out.push({ type: "space", text: " " }, t);
      lineStart = false;
      continue;
    }
    /* a field after a field on the same line: new line */
    if (!lineStart && prev && (prev.type === "field" || prev.type === "value" || prev.type === "string" || prev.type === "number" || (prev.type === "punct" && prev.text === ")")) && (t.type === "field" || t.type === "arg" || t.type === "keyword" || t.type === "comment")) nl();
    else sp();
    out.push(t);
    lineStart = false;
  }
  return out;
}

/** Formatted text alone. */
export const pretty = (source) =>
  format(source)
    .map((t) => t.text)
    .join("");

/** The colour class a token type wears. */
export const tone = (type) =>
  ({
    keyword: "text-magenta",
    field: "text-fg",
    arg: "text-cyan",
    value: "text-yellow",
    number: "text-yellow",
    string: "text-green",
    directive: "text-magenta",
    variable: "text-cyan",
    stage: "text-magenta",
    code: "text-dim",
    comment: "text-dim",
    punct: "text-dim",
    space: "",
  })[type] ?? "text-fg";

/** JSON re-indented when it parses whole; as it came otherwise. */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
