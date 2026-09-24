"use client";

/* The theme, chosen in the browser and kept there.
 *
 * An island, because the choice is the viewer's: the isolate renders one
 * view for everyone, and a theme set there would change for every tab.
 * It writes `data-theme` on <html>, which globals.css keys its palettes
 * on, and remembers the choice in localStorage. */
import { createSignal, onMount } from "solid-js";

const THEMES = [
  ["terminal", "terminal"],
  ["paper", "paper (white)"],
  ["solarized-dark", "solarized dark"],
  ["solarized-light", "solarized light"],
  ["gruvbox-dark", "gruvbox dark"],
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
  const [theme, setTheme] = createSignal("terminal");
  onMount(() => {
    let saved = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      /* storage may be unavailable; the default stands */
    }
    if (saved && THEMES.some(([k]) => k === saved)) {
      setTheme(saved);
      apply(saved);
    }
  });
  const choose = (name) => {
    setTheme(name);
    apply(name);
    try {
      localStorage.setItem(KEY, name);
    } catch {
      /* fine */
    }
  };
  return (
    <label class="text-dim">
      theme{" "}
      <select class="bg-bg text-fg" value={theme()} onChange={(e) => choose(e.currentTarget.value)}>
        {THEMES.map(([k, label]) => (
          <option value={k} selected={theme() === k}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
