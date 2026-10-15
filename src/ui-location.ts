import type { Plugin } from "@opencode/plugin/tui";
import { z } from "zod";

type Location = ReturnType<Plugin.Context["data"]["location"]["default"]>;
const MissingLocation = z.object({
  _tag: z.literal("LocationNotFoundError"),
  location: z.object({ directory: z.string() }),
});

export function uiErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = z.object({ message: z.string().min(1) }).safeParse(error);
  if (message.success) return message.data.message;
  const missing = MissingLocation.safeParse(error);
  if (missing.success) return `Location not found: ${missing.data.location.directory}`;
  const tagged = z.object({ _tag: z.string().optional(), type: z.string().optional(), name: z.string().optional() }).safeParse(error);
  if (tagged.success) return tagged.data._tag || tagged.data.type || tagged.data.name || "Unknown RPC error";
  return String(error);
}

const TransportFailure = z.object({ name: z.literal("ClientError"), reason: z.literal("Transport") });

// A shared-service restart drops in-flight requests, so one background refresh fails and a
// later one reconnects. Background refreshes report a transport failure only once it lasts.
export function transportGrace(graceMs = 15_000, now = Date.now) {
  let since: number | undefined;
  return {
    clear() {
      since = undefined;
    },
    shouldReport(error: unknown) {
      if (!TransportFailure.safeParse(error).success) {
        since = undefined;
        return true;
      }
      since ??= now();
      return now() - since >= graceMs;
    },
  };
}

// Global UI state can be read from another observed Location. Mutations that use
// the directory (workflow control/save) must keep their original routing.
export async function uiState<T>(
  ctx: Plugin.Context,
  sessionIDs: Iterable<string>,
  request: (location: Location) => Promise<T>,
): Promise<T> {
  const candidates = [
    ctx.location ?? ctx.data.location.default(),
    ctx.data.location.default(),
    ...[...sessionIDs].flatMap((id) => {
      const session = ctx.data.session.get(id);
      return session ? [session.location] : [];
    }),
  ];
  const tried = new Set<string>();
  let missing: unknown;
  for (const location of candidates) {
    const key = location.directory;
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      return await request(location);
    } catch (cause) {
      const parsed = MissingLocation.safeParse(cause);
      if (!parsed.success || parsed.data.location.directory !== location.directory)
        throw cause;
      missing = cause;
    }
  }
  throw missing;
}

export function applyWorkerSnapshot<T extends { workerID: string; coordinatorID: string }>(
  cache: Map<string, T>, coordinatorIDs: readonly string[], values: readonly T[],
) {
  const queried = new Set(coordinatorIDs);
  const retained = new Set(values.map((worker) => worker.workerID));
  for (const [id, worker] of cache)
    if (queried.has(worker.coordinatorID) && !retained.has(id)) cache.delete(id);
  for (const worker of values) cache.set(worker.workerID, worker);
}
