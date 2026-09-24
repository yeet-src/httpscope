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
import { For, createSignal, onMount } from "solid-js";

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
  });
  const choose = (name) => {
    setChosen(name);
    setPreview(null);
    apply(name);
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* fine */
    }
  };
  const hover = (name) => {
    setPreview(name);
    apply(name);
  };
  const leave = () => {
    setPreview(null);
    apply(chosen());
  };
  const shown = () => preview() ?? chosen();
  const label = (k) => THEMES.find(([key]) => key === k)?.[1] ?? k;

  return (
    <div class="fixed inset-x-0 bottom-0 flex items-stretch overflow-x-auto border-t border-rule bg-mode text-dim" onMouseLeave={leave}>
      {/* Powerline-style segments: an inverted block for the name of
          the thing, then the mode, then the choices. */}
      <span class="shrink-0 bg-fg px-3 py-0.5 text-bg">httpscope</span>
      <span class="shrink-0 bg-rule px-3 py-0.5 text-fg">theme</span>
      <span class="flex items-stretch">
        <For each={THEMES}>
          {([k, name]) => (
            <button
              class={`px-3 py-0.5 hover:text-fg ${shown() === k ? "bg-fg text-bg" : ""}`}
              onMouseEnter={() => hover(k)}
              onFocus={() => hover(k)}
              onClick={() => choose(k)}
              title={k}
            >
              {name}
            </button>
          )}
        </For>
      </span>
      <span class="ml-auto shrink-0 px-3 py-0.5">
        {preview() && preview() !== chosen() ? `previewing ${label(preview())} · click to keep` : label(chosen())}
      </span>
    </div>
  );
}
