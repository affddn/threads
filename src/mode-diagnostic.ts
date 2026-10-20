import type { z } from "zod";
import type { Configuration } from "./rpc";

type Mode = z.infer<typeof Configuration>["mode"];

export function modeDiagnostics(terminal: Mode) {
  const shown = new Set<string>();
  return (input: {
    configuration?: z.infer<typeof Configuration>;
    requestedDirectory: string;
    primaryDirectory: string;
    focusedDirectory?: string;
  }): string | undefined => {
    const { configuration, requestedDirectory, primaryDirectory, focusedDirectory } = input;
    const actual = configuration?.directory;
    const fallback = requestedDirectory !== primaryDirectory || (actual ?? requestedDirectory) !== primaryDirectory;
    if (configuration?.mode === terminal && !fallback) return;
    const location = configuration
      ? `server ${configuration.mode} at responding directory ${actual}`
      : `server mode unknown at requested directory ${requestedDirectory} (legacy snapshot has no responding-directory metadata)`;
    const scope = fallback
      ? ` Fallback global worker snapshot only; primary directory ${primaryDirectory}${focusedDirectory ? ` and focused directory ${focusedDirectory}` : ""} remain unverified.`
      : configuration ? "" : " Compatibility is unconfirmed.";
    const message = `Threads mode ${configuration && configuration.mode !== terminal ? "mismatch" : "unconfirmed"}: terminal ${terminal}; ${location}.${scope} Worker access remains available. This is not an active-workflow migration guard; keep workflow locations full.`;
    if (shown.has(message)) return;
    shown.add(message);
    return message;
  };
}
