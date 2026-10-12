import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { Permission } from "@opencode/schema/permission";
import { z } from "zod";
import { permissionMatches } from "./permissions";

export const EXTERNAL_DIRECTORY = "external_directory";
export const GRANTS_METADATA = "opThreadsPaths";

const external = (resource: string, effect: Permission.Effect): Permission.Rule => ({ action: EXTERNAL_DIRECTORY, resource, effect });
const governsExternal = (rule: Permission.Rule) => permissionMatches(rule.action, EXTERNAL_DIRECTORY);
const wildcard = (pattern: string) => /^\*+$/.test(pattern);

// Returns undefined when nothing is granted, so grant-free requests keep their existing fingerprints.
export async function resolveGrantedPaths(paths: readonly string[] | undefined): Promise<string[] | undefined> {
  if (paths === undefined || paths.length === 0) return undefined;
  const resolved = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error(`Granted path must be absolute: ${path}`);
    const real = await realpath(path).catch(() => undefined);
    const directory = real !== undefined && await stat(real).then((entry) => entry.isDirectory(), () => false);
    if (real === undefined || !directory) throw new Error(`Granted path must be an existing directory: ${path}`);
    if (dirname(real) === real) throw new Error(`Granted path cannot be a filesystem root: ${path}`);
    // Permission patterns read * and ? as wildcards and normalize backslashes, which would widen the grant.
    if (/[*?]/.test(real) || (process.platform !== "win32" && real.includes("\\"))) {
      throw new Error(`Granted path contains a character that permission patterns cannot match literally: ${real}`);
    }
    resolved.add(real);
  }
  return [...resolved].sort();
}

export async function withResolvedGrants<T extends { paths?: string[] }>(input: T): Promise<T> {
  const paths = await resolveGrantedPaths(input.paths);
  const { paths: _, ...rest } = input;
  return (paths === undefined ? rest : { ...rest, paths }) as T;
}

export function recordedGrants(metadata: Record<string, unknown> | undefined) {
  const value = metadata?.[GRANTS_METADATA];
  return value === undefined ? undefined : z.array(z.string().min(1)).min(1).parse(value);
}

export function grantNotice(paths: readonly string[] | undefined) {
  return paths === undefined || paths.length === 0
    ? ""
    : ` You may also use these granted directories when the task requires them: ${paths.join(", ")}.`;
}

export function asksExternal(rules: Permission.Ruleset) {
  return rules.some((rule) => rule.effect === "ask" && governsExternal(rule));
}

// Intersections of nested glob languages can use the narrower glob unchanged. Non-nested,
// overlapping languages cannot generally be expressed by one native permission rule.
function intersect(left: string, right: string): { pattern: string; exact: boolean } | undefined {
  const exact = (pattern: string) => ({ pattern, exact: true });
  const conservative = () => ({ pattern: left, exact: false });
  if (left === right || wildcard(right)) return exact(left);
  if (wildcard(left)) return exact(right);
  const normalize = (value: string) => value.replaceAll("\\", "/");
  const a = normalize(left), b = normalize(right);
  if (a === b) return exact(left);
  // JavaScript's native /i case folding is not equivalent to lowercasing Unicode strings.
  if (process.platform === "win32") return conservative();
  // Native shell patterns ending in ` *` also match the bare command. Do not infer inclusion
  // with the ordinary glob automaton for that special native syntax.
  if (a.endsWith(" *") || b.endsWith(" *")) return conservative();
  const literals = new Set([...a.split(""), ...b.split("")].filter((unit) => unit !== "*" && unit !== "?"));
  let other = "\0";
  while (literals.has(other)) other = String.fromCharCode(other.charCodeAt(0) + 1);
  const alphabet = [...literals, other];
  const closure = (pattern: string, positions: number[]) => {
    const result = new Set(positions);
    for (const position of result) if (pattern[position] === "*") result.add(position + 1);
    return [...result].sort((x, y) => x - y);
  };
  const advance = (pattern: string, positions: number[], unit: string) => closure(pattern, positions.flatMap((position) => {
    const token = pattern[position];
    return token === "*" ? [position] : token === "?" || token === unit ? [position + 1] : [];
  }));
  const queue: [number[], number[]][] = [[closure(a, [0]), closure(b, [0])]];
  const visited = new Set<string>();
  let aOnly = false, bOnly = false, overlap = false;
  for (let index = 0; index < queue.length; index++) {
    const [x, y] = queue[index]!;
    const key = `${x.join(",")};${y.join(",")}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > 10000) throw new Error(`Permission pattern composition exceeds state limit: ${left} & ${right}`);
    const acceptsA = x.includes(a.length), acceptsB = y.includes(b.length);
    aOnly ||= acceptsA && !acceptsB;
    bOnly ||= acceptsB && !acceptsA;
    overlap ||= acceptsA && acceptsB;
    for (const unit of alphabet) queue.push([advance(a, x, unit), advance(b, y, unit)]);
  }
  if (!overlap) return undefined;
  if (!aOnly) return exact(left);
  if (!bOnly) return exact(right);
  return conservative();
}

const stricter = (a: Permission.Effect, b: Permission.Effect): Permission.Effect =>
  a === "deny" || b === "deny" ? "deny" : a === "ask" || b === "ask" ? "ask" : "allow";

const unshadowed = (rules: Permission.Ruleset) => rules.filter((rule, index) => !rules.slice(index + 1).some((later) =>
  (later.action === rule.action || wildcard(later.action)) && (later.resource === rule.resource || wildcard(later.resource))));

// Lexicographic rule pairs preserve both last-match orders for representable intersections.
// Non-nested pairs emit a caller-region deny: they may overdeny but never authorize outside
// either policy. No unrestricted caller allow is copied through. Read projections retain the
// existing external-ask exemption; write callers must still ask without a shared allow or grant.
export function workerRestrictions(inherited: Permission.Ruleset, role: Permission.Ruleset, externalAsk: "ask" | "allow" = "ask"): Permission.Rule[] {
  // Some grant-free write callers deliberately do not load the destination role. With no role
  // available, retain restrictions only; exceptions cannot be restored safely.
  if (role.length === 0) return inherited.flatMap((rule): Permission.Rule[] => {
    if (rule.effect === "allow") return [];
    if (rule.effect === "ask" && governsExternal(rule)) return rule.action === EXTERNAL_DIRECTORY
      ? [external(rule.resource, "ask")]
      : [{ ...rule, effect: "deny" }, external(rule.resource, "ask")];
    return [{ ...rule, effect: "deny" }];
  });
  const caller = unshadowed([{ action: "*", resource: "*", effect: "allow" }, ...inherited]);
  const profile = unshadowed([{ action: "*", resource: "*", effect: "ask" }, ...role]);
  const result: Permission.Rule[] = [];
  for (const parent of caller) for (const worker of profile) {
    const action = intersect(parent.action, worker.action);
    if (action === undefined) continue;
    const resource = intersect(parent.resource, worker.resource);
    if (resource === undefined) continue;
    const precise = action.exact && resource.exact;
    const effect = precise ? stricter(parent.effect === "ask" ? "deny" : parent.effect, worker.effect) : "deny";
    result.push({ action: action.pattern, resource: resource.pattern, effect });
    if (permissionMatches(action.pattern, EXTERNAL_DIRECTORY)) {
      let callerEffect = parent.effect === "ask" ? externalAsk : parent.effect;
      // Keep the existing conservative shared-directory contract beside a caller ask.
      if (parent.effect === "allow" && asksExternal(inherited) && !wildcard(parent.resource) &&
        !role.some((rule) => rule.action === EXTERNAL_DIRECTORY && rule.resource === parent.resource && rule.effect === "allow")) callerEffect = "ask";
      const externalEffect = precise ? stricter(callerEffect, worker.effect) : "deny";
      if (action.pattern !== EXTERNAL_DIRECTORY || effect !== externalEffect) result.push(external(resource.pattern, externalEffect));
    }
  }
  return result;
}

// A catch-all `* *` deny is a baseline that grants override. Any other external_directory deny from
// the coordinator or the role is explicit.
export function explicitDenies(inherited: Permission.Ruleset, role: Permission.Ruleset) {
  return [...inherited, ...role].filter((rule) =>
    rule.effect === "deny" && governsExternal(rule) && !(wildcard(rule.action) && wildcard(rule.resource)));
}

// Grants follow every restriction so they win over asks and catch-all baselines. Explicit denies are
// reasserted after them and still win.
export function grantAccess(inherited: Permission.Ruleset, role: Permission.Ruleset, paths: readonly string[] | undefined): Permission.Rule[] {
  if (paths === undefined || paths.length === 0) return [];
  return [
    ...paths.flatMap((path) => [external(path, "allow"), external(`${path}/*`, "allow")]),
    ...explicitDenies(inherited, role).map((rule) => external(rule.resource, "deny")),
  ];
}

// `rules` are the worker's effective rules: its role's rules followed by its session rules. A grant
// covers its directory and its subtree, so a deny of either one blocks it.
export function assertGrantsReachable(rules: Permission.Ruleset, paths: readonly string[] | undefined) {
  for (const path of paths ?? []) {
    for (const resource of [path, `${path}/*`]) {
      const decision = rules.findLast((rule) => governsExternal(rule) && permissionMatches(rule.resource, resource));
      if (decision?.effect !== "allow") {
        throw new Error(`Granted path ${path} is blocked by an explicit external_directory deny (${decision?.resource ?? "no matching rule"})`);
      }
    }
  }
}

// OpenCode skips external_directory checks inside a session's project: the git worktree that git
// finds from its Location, or the Location itself outside a repository. This returns that directory
// or a wider one, never a narrower one. A `.git` file ends the search because git either uses it or
// fails. A `.git` directory ends it only if it looks valid, because git skips an invalid one.
export async function projectRoot(directory: string) {
  for (let current = directory; ; current = dirname(current)) {
    const marker = join(current, ".git");
    const entry = await stat(marker).catch(() => undefined);
    if (entry?.isFile() || (entry?.isDirectory() && await repositoryMarker(marker))) return current;
    if (dirname(current) === current) return directory;
  }
}

// A stricter form of git's own check: a symbolic or hexadecimal HEAD that is not a symlink, plus
// searchable `objects` and `refs`.
async function repositoryMarker(marker: string) {
  const head = join(marker, "HEAD");
  if (!await lstat(head).then((entry) => entry.isFile(), () => false)) return false;
  const content = await readFile(head, "utf8").catch(() => "");
  const searchable = await Promise.all(["objects", "refs"].map((name) =>
    access(join(marker, name), constants.X_OK).then(() => true, () => false)));
  return /^(?:ref:\s*refs\/|[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$)/.test(content) && searchable.every(Boolean);
}
