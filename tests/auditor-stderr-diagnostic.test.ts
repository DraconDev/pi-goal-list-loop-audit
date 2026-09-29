// pi-goal-list-loop-audit
// tests/auditor-stderr-diagnostic.test.ts
//
// Unit tests for the worker's stderr diagnostic accumulator. Control
// characters are built with fromCharCode so this file stays printable.

import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  accumulateStderrDiagnostic,
  STDERR_DIAGNOSTIC_MAX,
  stripStderrControlChars,
} from "../scripts/auditor-stderr-diagnostic.mjs";

const BEL = String.fromCharCode(7);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

test("a lone BEL flush contributes nothing (field bug: 90+ errors recorded only BEL)", () => {
  assert.equal(accumulateStderrDiagnostic(undefined, BEL), undefined);
  assert.equal(
    accumulateStderrDiagnostic("Agent stopped with error: boom", BEL),
    "Agent stopped with error: boom",
  );
});

test("stderr chunks accumulate in order", () => {
  let diag = accumulateStderrDiagnostic(undefined, "Agent stopped with error:");
  diag = accumulateStderrDiagnostic(diag, "provider returned 429");
  assert.equal(diag, "Agent stopped with error:\nprovider returned 429");
});

test("OSC sequences and control bytes are stripped, printable text kept", () => {
  assert.equal(stripStderrControlChars(`${ESC}]9;notify${BEL}real message`), "9;notifyreal message");
  assert.equal(stripStderrControlChars(`a${DEL}b`), "ab");
});

test("tab, LF, and CR survive; other C0 controls do not", () => {
  assert.equal(stripStderrControlChars("a\tb\nc\rd"), "a\tb\nc\rd");
  assert.equal(
    stripStderrControlChars(`x${String.fromCharCode(0)}y${String.fromCharCode(11)}z`),
    "xyz",
  );
});

test("accumulation is bounded, keeping the tail", () => {
  const big = "e".repeat(STDERR_DIAGNOSTIC_MAX + 100);
  const diag = accumulateStderrDiagnostic("head line", big);
  assert.equal(diag!.length, STDERR_DIAGNOSTIC_MAX);
  assert.ok(diag!.endsWith("e".repeat(100)));
});
