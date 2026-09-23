import assert from "node:assert/strict";
import { test } from "node:test";

import { clock, duration } from "../app/lib/fmt.js";

test("durations scale with their size", () => {
  assert.deepEqual([0.5, 3.21, 27, 999, 1240, 65_000, 3_600_000].map(duration), ["0.50ms", "3.2ms", "27ms", "999ms", "1.24s", "1m 05s", "60m 00s"]);
  assert.equal(duration(null), "–");
});

test("clock is HH:MM:SS local", () => {
  const d = new Date(2026, 8, 23, 9, 5, 7);
  assert.equal(clock(d.getTime()), "09:05:07");
});
