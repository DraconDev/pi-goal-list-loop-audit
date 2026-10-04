import { test } from "node:test";
import assert from "node:assert/strict";
import { buildWidgetLines } from "../extensions/goal-loop-display.js";
import { visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createRespecBuilder, adoptRespecRequirements, planRespecIncrement, blockRespecRequirement } from "../extensions/respec-builder.js";
import type { State } from "../extensions/goal-loop-core.js";

test("project cards expose phase, unfinished coverage and recorded blockers within narrow widths", () => {
  const drafted = adoptRespecRequirements(createRespecBuilder("Develop login and export"), [{ id: "login", text: "Login", acceptance: "Credentials verified" }, { id: "export", text: "Export", acceptance: "Data round-trips" }]);
  const building = planRespecIncrement(drafted, [{ id: "auth", text: "Implement and exercise login behavior", requirementIds: ["login"] }]);
  const blocked = blockRespecRequirement(building, "login", "Identity service unavailable");
  for (const builder of [drafted, building, blocked]) {
    const state = { goal: null, list: [], loop: { builder, active: builder !== blocked, target: builder.vision, startedAt: new Date().toISOString(), iteration: 1, maxIterations: 0, plateauWindow: 5, stallCount: 0, bestValue: null, lastValue: null, history: [] } } as State;
    for (const width of [1, 20, 40, 80, 120]) {
      const lines = buildWidgetLines(state, null, Date.now(), undefined, width)!;
      assert.ok(lines.every(line => visibleWidth(line) <= Math.max(0, width - 2)));
      assert.doesNotMatch(lines.join("\n"), /\x1b\[(?:\d+;)*3(?:;\d+)*m/);
      if (width >= 80) {
        const plain = stripTerminalSequences(lines.join("\n"));
        assert.match(plain, /verified 0\/2/);
        assert.match(plain, /remaining 2/);
        if (builder === blocked) { assert.match(plain, /Identity service unavailable/); assert.match(plain, /held/); }
      }
    }
  }
});
