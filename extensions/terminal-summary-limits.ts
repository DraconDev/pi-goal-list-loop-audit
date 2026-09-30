/** Shared outbox/receipt transport contract. A code point needs at most
 * six bytes in JSON (escaped ASCII controls exceed UTF-8's four-byte max).
 * Allow room for line separators and the host's receipt envelope. */
export const MAX_RENDER_CHAT_LINES = 150;
export const MAX_RENDER_LINE_CHARS = 2000;
export const MAX_TERMINAL_RECEIPT_BYTES =
  MAX_RENDER_CHAT_LINES * (MAX_RENDER_LINE_CHARS * 6 + 2) + 64 * 1024;
