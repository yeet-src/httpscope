/* The root layout: one nav line on a rule, and the buffer.
 *
 * It is an ordinary Solid component that runs in the isolate; the
 * pipeline is started from here so the capture is up from the first
 * frame — an agent's first query should find data, not start the taps.
 */
import { Link } from "yeetkit";

import { ensureStarted } from "@/lib/scope.js";

ensureStarted().catch((error) => console.error("httpscope pipeline failed to start:", error?.message ?? error));

export default function Layout(props) {
  const routes = [
    ["/", "*home*", true],
    ["/transactions", "*transactions*", false],
    ["/drift", "*drift*", false],
    ["/queries", "*queries*", false],
  ];

  return (
    <div class="min-h-screen bg-bg text-fg">
      <main class="mx-auto w-full max-w-screen-2xl px-4 py-4">
        <nav class="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule pb-2">
          <span class="text-fg">httpscope</span>
          {routes.map(([href, name, end]) => (
            <Link href={href} end={end} class="text-dim hover:text-fg" activeClass="!text-magenta !underline underline-offset-4">
              {name}
            </Link>
          ))}
          <a href="/api" class="ml-auto text-dim hover:text-fg">
            [api]
          </a>
        </nav>

        {props.children}
      </main>
    </div>
  );
}
