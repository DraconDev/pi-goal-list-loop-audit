/**
 * Bounded stderr diagnostic accumulator for the detached auditor worker.
 *
 * pi's stderr carries the real failure ("Agent stopped with error: ...") but
 * its final flush can be a lone BEL / OSC terminator. The old last-chunk-wins
 * capture let that terminator overwrite the real message, so 90+ field audit
 * errors recorded error BEL with the cause destroyed. This keeps every chunk
 * (control characters stripped) so the next death records its true cause.
 * Import-safe: no process or child-process dependencies.
 *
 * NOTE: control characters are matched by code point below, never by
 * backslash escapes, so this file stays printable ASCII throughout.
 */

/** stderr diagnostic budget: accumulation keeps the tail past this. */
export const STDERR_DIAGNOSTIC_MAX = 2000;

function isKeptCharCode(code) {
  // Tab, LF, CR survive; every other C0 control, DEL, and the C1 controls
  // (128-159) are stripped.
  if (code === 9 || code === 10 || code === 13) return true;
  if (code < 32 || (code >= 127 && code <= 159)) return false;
  return true;
}

const CODE_ESC = 27;
const CODE_BEL = 7;
const CODE_OSC_INTRODUCER = 93; // ]
const CODE_ST_BACKSLASH = 92; // backslash

/** Remove OSC sequences (ESC ] ... terminated by BEL or ESC backslash) as a
 * unit, so no introducer payload or terminator half survives in diagnostics. */
function stripOscSequences(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.codePointAt(i) === CODE_ESC && text.codePointAt(i + 1) === CODE_OSC_INTRODUCER) {
      i += 2;
      while (i < text.length) {
        const c = text.codePointAt(i);
        if (c === CODE_BEL) { i += 1; break; }
        if (c === CODE_ESC && text.codePointAt(i + 1) === CODE_ST_BACKSLASH) { i += 2; break; }
        i += 1;
      }
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** Strip OSC sequences, C0 controls (except tab/LF/CR), DEL, and C1 controls. */
export function stripStderrControlChars(text) {
  const units = stripOscSequences(String(text ?? ""));
  return [...units].filter((ch) => isKeptCharCode(ch.codePointAt(0))).join("");
}

/**
 * Fold one stderr chunk into the running diagnostic. Control-only chunks
 * (a lone BEL flush) contribute nothing and never mask earlier text.
 */
export function accumulateStderrDiagnostic(current, chunk) {
  const text = stripStderrControlChars(chunk);
  if (!text.trim()) return current;
  const next = current ? `${current}\n${text}` : text;
  return next.length > STDERR_DIAGNOSTIC_MAX ? next.slice(-STDERR_DIAGNOSTIC_MAX) : next;
}
