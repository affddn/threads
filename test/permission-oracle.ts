import { readFileSync } from "node:fs";
import type { Permission } from "@opencode/schema/permission";

export const nativeSource = process.env.OPENCODE_SOURCE;
type Evaluate = (action: string, resource: string, ...rules: Permission.Ruleset[]) => Permission.Rule;

function load(root: string): Evaluate {
  const source = readFileSync(`${root}/packages/core/src/permission.ts`, "utf8");
  const start = source.indexOf("export function evaluate(");
  const end = source.indexOf("\nexport function merge(", start);
  const wildcard = readFileSync(`${root}/packages/core/src/util/wildcard.ts`, "utf8").replace(/^export \* as Wildcard.*\n/m, "");
  if (start < 0 || end < 0) throw new Error("Native evaluator source boundary changed");
  // Run the unchanged native function bodies without importing their unrelated service graph.
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`${wildcard.replace("export function match", "function match")}\nconst Wildcard = { match };\n${source.slice(start, end).replace("export function", "function")}\nreturn evaluate;`);
  return new Function(code)();
}

export const nativeEvaluate = nativeSource ? load(nativeSource) : undefined;
