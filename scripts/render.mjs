#!/usr/bin/env node
/* Render a page headless: connect to the hub as a browser would, ask
 * for a path, apply the patches for a while, print the text.
 *
 *   node scripts/render.mjs / [--port 3000] [--ms 3000]
 *   node scripts/render.mjs /queries --click "endpoints(" --snap 3000,12000
 *
 * For checking a page without a browser; the tree is what the isolate
 * sent, after the page's own ticks have filled it in. `--click` sends a
 * click to the first listening element whose text contains the string,
 * the way the browser client would; `--snap` prints the tree at each of
 * those times after the click.
 */
const args = process.argv.slice(2);
const path = args.find((a) => !a.startsWith("--")) ?? "/";
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const port = Number(opt("--port", 3000));
const wait = Number(opt("--ms", 3000));
const click = opt("--click", null);
const snaps = opt("--snap", null)?.split(",").map(Number) ?? [];

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OSC_OPEN = "\x1b]7880;";
const OSC_CLOSE = "\x07";
const encode = (message) => {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  let out = "";
  let bits = 0;
  let width = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    width += 8;
    while (width >= 6) {
      width -= 6;
      out += B64[(bits >> width) & 0x3f];
    }
  }
  if (width > 0) out += B64[(bits << (6 - width)) & 0x3f];
  return new TextEncoder().encode(`${out}\n`);
};

/* A DOM of plain objects. */
const nodes = new Map();
const listeners = new Map(); /* id → Set(type) */
const root = { id: 0, tag: "root", kids: [] };
nodes.set(0, root);
const build = (n) => {
  const node = { id: n.id, tag: n.tag ?? null, text: n.text ?? null, attrs: n.attrs ?? {}, kids: [] };
  nodes.set(n.id, node);
  /* Handlers ride on the node: `on: ["click"]`. */
  for (const type of n.on ?? []) (listeners.get(n.id) ?? listeners.set(n.id, new Set()).get(n.id)).add(type);
  for (const k of n.kids ?? []) node.kids.push(build(k));
  return node;
};
const detach = (node) => {
  for (const n of nodes.values()) {
    const i = n.kids.indexOf(node);
    if (i >= 0) n.kids.splice(i, 1);
  }
};
/* A removed subtree takes its ids with it, as the browser client does. */
const forget = (node) => {
  nodes.delete(node.id);
  listeners.delete(node.id);
  for (const k of node.kids) forget(k);
};
let mounted = false;
const apply = (p) => {
  switch (p.op) {
    case "listen":
      (listeners.get(p.id) ?? listeners.set(p.id, new Set()).get(p.id)).add(p.type);
      break;
    case "batch":
      p.patches.forEach(apply);
      break;
    case "mount":
      nodes.clear();
      listeners.clear();
      root.kids = (p.root.kids ?? []).map(build);
      nodes.set(0, root);
      mounted = true;
      break;
    case "insert": {
      const parent = nodes.get(p.parent);
      if (!parent) return;
      /* An id already in the tree is being re-placed: take the old copy out. */
      const stale = nodes.get(p.node.id);
      if (stale) {
        detach(stale);
        forget(stale);
      }
      const node = build(p.node);
      const at = p.before == null ? -1 : parent.kids.findIndex((k) => k.id === p.before);
      if (at < 0) parent.kids.push(node);
      else parent.kids.splice(at, 0, node);
      break;
    }
    case "remove": {
      const node = nodes.get(p.id);
      if (node) {
        detach(node);
        forget(node);
      }
      break;
    }
    case "text": {
      const node = nodes.get(p.id);
      if (node) node.text = p.value;
      break;
    }
    case "attr": {
      const node = nodes.get(p.id);
      if (node) node.attrs[p.name] = p.value;
      break;
    }
  }
};

const BLOCK = new Set(["p", "div", "tr", "h1", "h2", "li", "pre", "section", "nav", "table", "thead", "tbody", "dt", "dd", "details", "summary"]);
const render = (node, out = []) => {
  if (node.text != null) out.push(node.text);
  for (const k of node.kids) render(k, out);
  if (BLOCK.has(node.tag)) out.push("\n");
  if (node.tag === "td" || node.tag === "th" || node.tag === "dt") out.push("  ");
  return out;
};

const socket = new WebSocket(`ws://127.0.0.1:${port}/@yeetkit/ws`);
socket.binaryType = "arraybuffer";
let pending = "";
socket.addEventListener("message", (event) => {
  pending += typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
  for (;;) {
    const start = pending.indexOf(OSC_OPEN);
    if (start < 0) return;
    const end = pending.indexOf(OSC_CLOSE, start);
    if (end < 0) return;
    try {
      apply(JSON.parse(pending.slice(start + OSC_OPEN.length, end)));
    } catch {}
    pending = pending.slice(end + OSC_CLOSE.length);
  }
});
await new Promise((done, fail) => {
  socket.addEventListener("open", done);
  socket.addEventListener("error", () => fail(new Error(`cannot reach the hub on ${port}`)));
});
socket.send(encode({ t: "hello", path }));
await new Promise((r) => setTimeout(r, wait));
if (!mounted) {
  console.error("no mount frame arrived");
  process.exit(1);
}
const show = (label) => {
  const text = render(root)
    .join("")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (label) console.log(`===== ${label}`);
  console.log(text);
};
if (click) {
  /* The first element with a click listener whose text has the string. */
  const textOf = (n) => (n.text ?? "") + n.kids.map(textOf).join("");
  /* In document order, so "the first row" means the one on top. */
  const inOrder = [];
  const visit = (n) => {
    inOrder.push(n);
    n.kids.forEach(visit);
  };
  visit(root);
  const target = inOrder.find((n) => listeners.get(n.id)?.has("click") && textOf(n).includes(click));
  if (!target) {
    show();
    const listening = [...listeners.entries()].map(([id, types]) => `${id}:${[...types].join("+")}=${JSON.stringify(textOf(nodes.get(id) ?? { kids: [] }).slice(0, 30))}`);
    console.error(`no clickable element containing ${JSON.stringify(click)}; ${listeners.size} listeners: ${listening.slice(0, 8).join(" ")}`);
    socket.close();
    process.exit(1);
  }
  socket.send(encode({ t: "event", id: target.id, type: "click", payload: {} }));
  let elapsed = 0;
  for (const at of snaps.length ? snaps : [500]) {
    await new Promise((r) => setTimeout(r, Math.max(0, at - elapsed)));
    elapsed = at;
    show(`${at} ms after the click`);
  }
} else show();
socket.close();
