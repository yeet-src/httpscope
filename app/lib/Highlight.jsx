/* Coloured text for the pages: a header list, a body.
 *
 * Headers show name and value in two tones, with credential-bearing
 * values in orange so a token over plaintext is seen for what it is. A
 * body that looks like JSON is coloured token by token; anything else is
 * shown as it came. Both are plain spans inside a <pre>, so the text
 * selects and copies as text. */
import { For, Show } from "yeetkit";

import { SENSITIVE_HEADERS, looksJson, tokenizeJson, tone } from "@/lib/gql.js";

/** `headers` is `[[name, value]]`. */
export function Headers(props) {
  return (
    <pre class="whitespace-pre-wrap break-all">
      <For each={props.headers ?? []} fallback={<span class="text-dim">{props.empty ?? "no headers"}</span>}>
        {([name, value]) => (
          <>
            <span class="text-cyan">{name}</span>
            <span class="text-dim">: </span>
            <span class={SENSITIVE_HEADERS.has(name) ? "text-orange" : "text-fg"}>{value}</span>
            {"\n"}
          </>
        )}
      </For>
    </pre>
  );
}

/** A body as text; JSON gets colours. `class` sets the box. */
export function Body(props) {
  return (
    <pre class={`whitespace-pre-wrap break-all ${props.class ?? "max-h-96 overflow-auto"}`}>
      <Show when={looksJson(props.text)} fallback={<span class="text-fg">{props.text}</span>}>
        <For each={tokenizeJson(props.text)}>{(t) => <span class={tone(t.type)}>{t.text}</span>}</For>
      </Show>
    </pre>
  );
}
