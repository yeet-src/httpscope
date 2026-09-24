"use client";

/* The mode line: a bar along the bottom, in segments, carrying the
 * theme choice.
 *
 * An island, because the choice is the viewer's: the isolate renders
 * one view for everyone, and a theme set there would change every tab.
 * Hovering a name previews it on the whole page; leaving the bar puts
 * the chosen one back; a click keeps it. It writes `data-theme` on
 * <html>, which globals.css keys its palettes on, and remembers the
 * choice in localStorage. */
import { For, Show, createSignal, onMount } from "solid-js";

const THEMES = [
  ["terminal", "terminal"],
  ["paper", "paper"],
  ["solarized-dark", "solarized"],
  ["solarized-light", "solarized light"],
  ["gruvbox-dark", "gruvbox"],
  ["gruvbox-light", "gruvbox light"],
  ["nord", "nord"],
  ["dracula", "dracula"],
  ["tokyo-night", "tokyo night"],
  ["one-light", "one light"],
];
const KEY = "httpscope.theme";

const apply = (name) => {
  if (name === "terminal") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = name;
};

export default function ThemePicker() {
  const [chosen, setChosen] = createSignal("terminal");
  const [preview, setPreview] = createSignal(null);
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    let saved = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* storage may be unavailable; the default stands */
    }
    if (saved && THEMES.some(([k]) => k === saved)) {
      setChosen(saved);
      apply(saved);
    }
    /* Escape closes and reverts; a click elsewhere does the same. */
    document.addEventListener("keydown", (e) => e.key === "Escape" && close());
    document.addEventListener("click", (e) => {
      if (open() && !e.target.closest?.("[data-theme-menu]")) close();
    });
  });
  const close = () => {
    setOpen(false);
    setPreview(null);
    apply(chosen());
  };
  const choose = (name) => {
    setChosen(name);
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* fine */
    }
    close();
  };
  const hover = (name) => {
    setPreview(name);
    apply(name);
  };
  const shown = () => preview() ?? chosen();
  const label = (k) => THEMES.find(([key]) => key === k)?.[1] ?? k;

  return (
    <div class="fixed inset-x-0 bottom-0 flex items-stretch border-t border-rule bg-mode text-dim" data-theme-menu>
      {/* Powerline-style segments: an inverted block for the name, then
          the theme segment, which is the menu's handle. */}
      <span class="shrink-0 bg-fg px-3 py-0.5 text-bg">httpscope</span>
      <span class="relative">
        <button class={`px-3 py-0.5 hover:text-fg ${open() ? "bg-rule text-fg" : ""}`} onClick={() => (open() ? close() : setOpen(true))} aria-haspopup="menu" aria-expanded={open()}>
          theme <span class="text-fg">{label(chosen())}</span> {open() ? "▾" : "▴"}
        </button>
        <Show when={open()}>
          {/* The menu, above the bar: hovering a row previews it on the
              page, leaving the menu reverts, a click keeps. */}
          <ul class="absolute bottom-full left-0 mb-px min-w-48 border border-rule bg-mode py-1" role="menu" onMouseLeave={() => { setPreview(null); apply(chosen()); }}>
            <For each={THEMES}>
              {([k, name]) => (
                <li>
                  <button
                    class={`flex w-full items-baseline gap-3 px-3 py-0.5 text-left hover:text-fg ${shown() === k ? "bg-fg text-bg" : ""}`}
                    role="menuitem"
                    onMouseEnter={() => hover(k)}
                    onFocus={() => hover(k)}
                    onClick={() => choose(k)}
                  >
                    <span class="w-3">{chosen() === k ? "•" : ""}</span>
                    {name}
                  </button>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </span>
      <span class="ml-auto shrink-0 px-3 py-0.5">{preview() && preview() !== chosen() ? `previewing ${label(preview())} · click to keep` : ""}</span>
    </div>
  );
}
