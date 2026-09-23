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
        out.push({ type: "code", text: body, stage: m[1] });
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
          const body = dedent(tokens[k].text);
          const multi = body.includes("\n");
          out.push({ type: "space", text: multi ? "\n  " : " " });
          if (tokens[k].stage === "ai") out.push({ type: "prose", text: multi ? body.replace(/\n/g, "\n  ") : body });
          else for (const jt of tokenizeJs(body)) out.push(multi && jt.type === "space" ? { ...jt, text: jt.text.replace(/\n/g, "\n  ") } : jt);
          out.push({ type: "space", text: multi ? "\n" : " " });
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

/* Strip the common leading indentation of a multi-line body. */
function dedent(text) {
  const lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(cut)).join("\n").trim();
}

const JS_KEYWORDS = new Set(["let", "const", "var", "function", "return", "if", "else", "for", "of", "in", "while", "do", "new", "typeof", "instanceof", "true", "false", "null", "undefined", "async", "await", "try", "catch", "finally", "throw", "switch", "case", "break", "continue", "default", "class", "this", "delete", "void", "yield"]);

/** JavaScript, cut into coloured tokens: js-keyword, js-string, js-number, js-comment, js-row (`$`), js-ident, js-punct, space. */
export function tokenizeJs(source) {
  const out = [];
  const s = String(source ?? "");
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      let j = i;
      while (j < s.length && /\s/.test(s[j])) j++;
      out.push({ type: "space", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (s.startsWith("//", i)) {
      let j = s.indexOf("\n", i);
      if (j < 0) j = s.length;
      out.push({ type: "js-comment", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (s.startsWith("/*", i)) {
      let j = s.indexOf("*/", i + 2);
      j = j < 0 ? s.length : j + 2;
      out.push({ type: "js-comment", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === "\\") j++;
        j++;
      }
      out.push({ type: "js-string", text: s.slice(i, Math.min(j + 1, s.length)) });
      i = Math.min(j + 1, s.length);
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < s.length && /[0-9a-fA-FxX._eE+-]/.test(s[j]) && !(s[j] === "-" && !/[eE]/.test(s[j - 1])) && !(s[j] === "+" && !/[eE]/.test(s[j - 1]))) j++;
      out.push({ type: "js-number", text: s.slice(i, j) });
      i = j;
      continue;
    }
    if (c === "$" && !/[A-Za-z0-9_]/.test(s[i + 1] ?? "")) {
      out.push({ type: "js-row", text: "$" });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$]/.test(s[j])) j++;
      const word = s.slice(i, j);
      out.push({ type: JS_KEYWORDS.has(word) ? "js-keyword" : "js-ident", text: word });
      i = j;
      continue;
    }
    out.push({ type: "js-punct", text: c });
    i++;
  }
  return out;
}

/** The root fields a document selects: `["endpoints", "services"]` — aliases as written. */
export function rootsOf(source) {
  const out = [];
  let depth = 0;
  let parens = 0;
  const tokens = tokenize(source).filter((t) => t.type !== "space" && t.type !== "comment");
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "code" || t.type === "stage") continue;
    if (t.type === "punct") {
      if (t.text === "(" || t.text === "[") parens++;
      else if (t.text === ")" || t.text === "]") parens = Math.max(0, parens - 1);
      else if (t.text === "{" && parens === 0) depth++;
      else if (t.text === "}" && parens === 0) depth = Math.max(0, depth - 1);
      else if (t.text === "|") depth = 0;
      continue;
    }
    if (depth === 1 && parens === 0 && (t.type === "field" || t.type === "arg") && !out.includes(t.text)) {
      const prev = tokens[k - 1];
      if (prev?.type === "punct" && (prev.text === ":" || prev.text === "@" || prev.text === "$")) continue;
      out.push(t.text);
    }
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
    prose: "text-fg",
    comment: "text-dim",
    punct: "text-dim",
    space: "",
    "js-keyword": "text-magenta",
    "js-string": "text-green",
    "js-number": "text-yellow",
    "js-comment": "text-dim",
    "js-row": "text-cyan",
    "js-ident": "text-fg",
    "js-punct": "text-dim",
  })[type] ?? "text-fg";

/**
 * Light markdown for an `ai` instruction: paragraphs, `- ` bullets,
 * **bold** and `code`. Returns `[{ kind: "text" | "bold" | "code" | "br", text }]`,
 * for a renderer to turn into spans.
 */
export function inlineMarkdown(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    const bullet = /^(\s*)[-*]\s+/.exec(line);
    let rest = line;
    if (bullet) {
      out.push({ kind: "text", text: bullet[1] + "• " });
      rest = line.slice(bullet[0].length);
    }
    const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
    let last = 0;
    let m;
    while ((m = re.exec(rest))) {
      if (m.index > last) out.push({ kind: "text", text: rest.slice(last, m.index) });
      out.push(m[0].startsWith("`") ? { kind: "code", text: m[0].slice(1, -1) } : { kind: "bold", text: m[0].slice(2, -2) });
      last = m.index + m[0].length;
    }
    if (last < rest.length) out.push({ kind: "text", text: rest.slice(last) });
    if (i < lines.length - 1) out.push({ kind: "br", text: "\n" });
  });
  return out;
}

/** JSON re-indented when it parses whole; as it came otherwise. */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
