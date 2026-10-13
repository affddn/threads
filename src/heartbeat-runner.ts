import { Service } from "@opencode/client/service";
import { OpenCode } from "@opencode/client";
import { lstat, mkdir, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { HeartbeatRpc, SnapshotOutput } from "./heartbeat-rpc";
import { heartbeatObserve } from "./heartbeat-observe";
import { heartbeatProjectionDecision } from "./heartbeat-policy";
import { heartbeatEndpoint, heartbeatFetch } from "./heartbeat-transport";

export const RunnerConfig = z.object({ protocol: z.literal(1), serviceFile: z.string(), hostDirectory: z.string(), node: z.string(), runner: z.string(), intervalMs: z.literal(60_000), label: z.string().regex(/^com\.opthreads\.heartbeat(?:\.[a-zA-Z0-9-]+)?$/), launchAgentsDirectory: z.string() }).strict();
export type RunnerConfig = z.infer<typeof RunnerConfig>;
function absolute(path: string) { if (!isAbsolute(path)) throw new Error("Heartbeat paths must be absolute"); return path; }
export async function heartbeatConnection(config: RunnerConfig) {
  const endpoint = await heartbeatEndpoint(absolute(config.serviceFile));
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint), fetch: heartbeatFetch });
  const rpc = client.rpc(HeartbeatRpc);
  return { client, rpc };
}
export async function heartbeatOnce(config: RunnerConfig, shadow: boolean) {
  return heartbeatCycle(config, shadow, await heartbeatConnection(config));
}
export async function heartbeatCycle(config: RunnerConfig, shadow: boolean, connection: Awaited<ReturnType<typeof heartbeatConnection>>) {
  const { client, rpc } = connection;
  let afterOwnerID: string | undefined;
  const decisions = [];
  do {
    const page = SnapshotOutput.parse(await rpc.snapshot({ afterOwnerID, limit: 100 }, { location: { directory: config.hostDirectory } }));
    for (const entry of page.entries) {
      try {
        const observation = await heartbeatObserve(client, entry);
        if (shadow) decisions.push({ monitorID: entry.record.monitorID, observation, mode: entry.record.mode, wakesReserved: entry.record.wakesReserved, deadlineAt: entry.record.deadlineAt, decision: heartbeatProjectionDecision(entry.record, entry.run ?? undefined, observation, Date.now()) });
        else decisions.push(await rpc.apply({ ownerID: entry.record.ownerID, monitorID: entry.record.monitorID, expectedRevision: entry.record.revision, bindingEpoch: entry.record.binding.epoch, observation }, { location: { directory: config.hostDirectory } }));
      } catch (error) {
        decisions.push({ monitorID: entry.record.monitorID, ownerID: entry.record.ownerID, status: "unavailable", detail: String(error).slice(0, 2_000) });
      }
    }
    afterOwnerID = page.next;
  } while (afterOwnerID);
  return { protocol: 1, shadow, decisions };
}
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export function heartbeatPlist(config: RunnerConfig, configFile: string, stateDirectory: string) {
  const args = [config.node, config.runner, "run", "--config", configFile];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(config.label)}</string><key>ProgramArguments</key><array>${args.map((value) => `<string>${xml(value)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>WorkingDirectory</key><string>${xml(config.hostDirectory)}</string><key>StandardOutPath</key><string>${xml(join(stateDirectory, "runner.log"))}</string><key>StandardErrorPath</key><string>${xml(join(stateDirectory, "runner.error.log"))}</string></dict></plist>\n`;
}
function launchctl(...args: string[]) {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
async function requireVacant(path: string) {
  try { await lstat(path); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
  throw new Error(`Heartbeat path already occupied; uninstall explicitly first: ${path}`);
}
export async function heartbeatCli(args = process.argv.slice(2)) {
  const command = args.shift();
  const flags = new Map<string, string>();
  let shadow = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--shadow") { shadow = true; continue; }
    if (!flag?.startsWith("--") || !args.length) throw new Error("Expected named option and value");
    flags.set(flag, args.shift()!);
  }
  const allowed = new Set(["--config", "--service-file", "--host-directory", "--node", "--label", "--launchagents-directory"]);
  for (const flag of flags.keys()) if (!allowed.has(flag)) throw new Error(`Unknown heartbeat option ${flag}`);
  const configFile = absolute(flags.get("--config") ?? join(homedir(), "Library", "Application Support", "op-threads-heartbeat", "config.json"));
  const stateDirectory = dirname(configFile);
  const domain = `gui/${process.getuid?.()}`;
  if (command === "install") {
    if (process.platform !== "darwin") throw new Error("Heartbeat installer supports macOS only");
    await requireVacant(configFile);
    const config = RunnerConfig.parse({ protocol: 1, serviceFile: absolute(flags.get("--service-file") ?? ""), hostDirectory: absolute(flags.get("--host-directory") ?? ""),
      node: await realpath(absolute(flags.get("--node") ?? process.execPath)), runner: await realpath(fileURLToPath(import.meta.url)), intervalMs: 60_000,
      label: flags.get("--label") ?? "com.opthreads.heartbeat", launchAgentsDirectory: absolute(flags.get("--launchagents-directory") ?? join(homedir(), "Library", "LaunchAgents")) });
    if (!(await stat(config.hostDirectory)).isDirectory()) throw new Error("Stable host directory unavailable");
    const isolatedTest = config.label !== "com.opthreads.heartbeat" && stateDirectory.includes("/.audit/recovery/heartbeat/") && config.launchAgentsDirectory.startsWith(`${stateDirectory}/`) && config.hostDirectory.startsWith(`${stateDirectory}/`);
    if (!isolatedTest && (config.hostDirectory.includes(".opencode-workflows") || config.runner.includes(".opencode-workflows"))) throw new Error("Install from stable packaged paths, not task worktrees");
    const plist = join(config.launchAgentsDirectory, `${config.label}.plist`);
    await requireVacant(plist);
    const existing = launchctl("print", `${domain}/${config.label}`);
    if (existing.code === 0) throw new Error("Heartbeat label already loaded; uninstall explicitly first");
    if (existing.code !== 113 || !existing.stderr.includes("Could not find service")) throw new Error(`Cannot establish vacant Heartbeat label: ${existing.stderr}`);
    await heartbeatOnce(config, true);
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(config.launchAgentsDirectory, { recursive: true });
    const created: { path: string; identity: Awaited<ReturnType<typeof lstat>> }[] = [];
    async function create(path: string, contents: string) {
      const file = await open(path, "wx", 0o600);
      try { created.push({ path, identity: await file.stat() }); await file.writeFile(contents); }
      finally { await file.close(); }
    }
    let bootstrapped = false;
    try {
      await create(configFile, JSON.stringify(config, null, 2));
      await create(plist, heartbeatPlist(config, configFile, stateDirectory));
      const boot = launchctl("bootstrap", domain, plist);
      if (boot.code !== 0) throw new Error(`LaunchAgent bootstrap failed: ${boot.stderr}`);
      bootstrapped = true;
      const readback = launchctl("print", `${domain}/${config.label}`);
      if (readback.code !== 0) throw new Error("LaunchAgent readback failed after successful bootstrap; configuration retained for explicit uninstall");
      return { installed: true, configFile, readback };
    } catch (error) {
      if (!bootstrapped) for (const file of created.reverse()) {
        const current = await lstat(file.path).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
          throw cause;
        });
        if (current?.dev === file.identity.dev && current.ino === file.identity.ino) await rm(file.path);
      }
      throw error;
    }
  }
  const config = RunnerConfig.parse(JSON.parse(await readFile(configFile, "utf8")));
  if (command === "status") {
    const launcher = process.platform === "darwin" ? launchctl("print", `${domain}/${config.label}`) : { code: -1, stdout: "", stderr: "unsupported platform" };
    const observation = await heartbeatOnce(config, true).then((result) => ({ available: true, result }), (error) => ({ available: false, reason: String(error) }));
    return { config, launcher, observation };
  }
  if (command === "uninstall") {
    if (process.platform !== "darwin") throw new Error("Heartbeat uninstall supports macOS only");
    const stopped = launchctl("bootout", `${domain}/${config.label}`);
    let readback = launchctl("print", `${domain}/${config.label}`);
    for (let attempt = 0; readback.code === 0 && attempt < 50; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      readback = launchctl("print", `${domain}/${config.label}`);
    }
    if (readback.code === 0) throw new Error("LaunchAgent still loaded; configuration retained");
    if (readback.code !== 113 || !readback.stderr.includes("Could not find service")) throw new Error("LaunchAgent absence unavailable; configuration retained");
    await rm(join(config.launchAgentsDirectory, `${config.label}.plist`), { force: true });
    await rm(configFile);
    return { uninstalled: true, stopped, readback, detail: "monitor records and logs retained; no workflow control" };
  }
  if (command === "once") return heartbeatOnce(config, shadow);
  if (command !== "run" || shadow) throw new Error("Usage: op-threads-heartbeat install|run|once --shadow|status|uninstall [--config absolute-path]");
  for (;;) {
    try { process.stdout.write(`${JSON.stringify(await heartbeatOnce(config, false))}\n`); }
    catch (error) { process.stderr.write(`${JSON.stringify({ unavailable: String(error), at: Date.now() })}\n`); }
    await new Promise((resolve) => setTimeout(resolve, config.intervalMs));
  }
}
