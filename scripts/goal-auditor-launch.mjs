/**
 * Build the detached auditor's pi child-process invocation.
 *
 * POSIX can execute npm's shebang entrypoint directly. Windows npm installs a
 * `pi.cmd` shim instead, so the launch must go through cmd.exe. Keep this
 * wrapper explicit rather than using child_process.spawn(..., { shell: true })
 * with an args array: Node warns that shell mode concatenates those arguments
 * without escaping them.
 */

const WINDOWS_UNSAFE_ARG = /[\r\n%]/;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200];

/** Quote one argument for the Windows command interpreter/CRT boundary. */
export function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (WINDOWS_UNSAFE_ARG.test(text)) {
    throw new Error("unsafe Windows auditor launch argument");
  }

  let result = '"';
  let backslashes = 0;
  for (const character of text) {
    if (character === "\\") {
      backslashes++;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  // Backslashes immediately before the closing quote must be doubled.
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

/**
 * Return the file, argv, and spawn options for child_process.spawn(). The
 * optional platform/comspec parameters make the Windows branch deterministic
 * to test without pretending that a Linux host is Windows.
 */
export function buildAuditorPiSpawnSpec(
  piBinary,
  piArgs,
  platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
) {
  if (platform !== "win32") {
    return { file: piBinary, args: [...piArgs], options: {} };
  }

  const command = [piBinary, ...piArgs]
    .map((argument) => /[\s"&|<>^()]/.test(String(argument)) ? quoteWindowsCommandArgument(argument) : String(argument))
    .join(" ");

  // /s /c needs an outer quote pair around a command whose executable and
  // arguments are quoted individually: cmd strips the outer pair and runs the
  // inner command. windowsVerbatimArguments prevents Node from rewriting the
  // already-escaped command string before cmd.exe receives it.
  return {
    file: comspec,
    args: ["/d", "/s", "/c", `"${command}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/**
 * Retry only rename errors that Windows can produce while an antivirus scan or
 * a concurrent reader briefly holds the destination. The old destination is
 * never unlinked, so readers observe either the previous or complete snapshot.
 */
export async function renameWithWindowsRetry(
  renameFn,
  temp,
  file,
  platform = process.platform,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
) {
  for (let attempt = 0; ; attempt++) {
    try {
      await renameFn(temp, file);
      return;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : undefined;
      const delay = platform === "win32" && typeof code === "string" && WINDOWS_RENAME_RETRY_CODES.has(code)
        ? WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]
        : undefined;
      if (delay === undefined) throw error;
      await sleep(delay);
    }
  }
}
