// Terminal input for the interactive account commands (bootstrap-owner, reset-owner-password). Nothing typed
// here is ever passed on the command line, so it never reaches shell history or process listings.
import { createInterface } from "node:readline/promises";

/** Refuses piped or redirected input: a password must be typed by a person. */
export function assertInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this command in an interactive terminal; it does not read input from a pipe or file.");
  }
}

export async function askVisible(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Reads one line in raw mode without echoing it. */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          reject(new Error("Cancelled. Nothing was changed."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    // Input closed before Enter (for example Ctrl+Z on Windows): stop with a message, never silently.
    const onEnd = () => {
      finish();
      reject(new Error("Input closed. Nothing was changed."));
    };
    process.stdout.write(question);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
}

/** Asks twice without echo and stops if the two entries differ. */
export async function askNewPassword(): Promise<string> {
  const password = await askHidden("Password (not shown): ");
  if ((await askHidden("Repeat password: ")) !== password) throw new Error("The passwords do not match. Nothing was changed.");
  return password;
}
