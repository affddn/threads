import { expect, test } from "bun:test";
import { executeWorkflow, type WorkflowHost } from "../src/workflow-runtime";

const host: WorkflowHost = {
  agent: async (input) => input, phase: async () => {}, log: async () => {},
  checkpoint: async (input) => input, workflow: async (input) => input,
};
const run = (body: string, options: Partial<Parameters<typeof executeWorkflow>[0]> = {}) => executeWorkflow({
  script: `export const meta = { name: "helper-budgets", description: "real worker" };\n${body}`,
  args: null, signal: new AbortController().signal, host, helperPolicy: "optional-counts", ...options,
});

test("optional retry/gate exceed three and discovery exceeds ten, then stops after two empty rounds", async () => {
  expect(await run(`
    const retried = await retry((attempt) => { if (attempt < 6) throw new Error("again"); return attempt; });
    const gated = await gate((attempt) => attempt, (value) => value === 7);
    let rounds = 0;
    const found = await loopUntilDry({ key: "id", round: (index) => { rounds = index; return index <= 12 ? [{id:index}] : []; } });
    return { retried, gated, rounds, found: found.length };
  `, {timeoutMs:2000})).toEqual({ retried: 6, gated: 7, rounds: 14, found: 12 });
});

test("explicit helper counts stop exactly at their boundaries", async () => {
  expect(await run(`
    let retries = 0;
    let gates = 0;
    try { await retry((attempt) => { retries = attempt; throw new Error("retry-boundary"); }, {attempts: 4}); } catch (error) { if (error.message !== "retry-boundary") throw error; }
    try { await gate((attempt) => { gates = attempt; return attempt; }, () => false, {attempts: 5}); } catch (error) { if (error.message !== "Workflow gate rejected the result") throw error; }
    const found = await loopUntilDry({key:"id", maxRounds:11, round:(index) => [{id:index}]});
    return { retries, gates, rounds:found.length };
  `)).toEqual({ retries: 4, gates: 5, rounds: 11 });
  expect(await run(`return retry((attempt) => { if (attempt < 4) throw new Error("again"); return attempt; }, {attempts:4});`)).toBe(4);
  expect(await run(`return gate((attempt) => attempt, (value) => value === 4, {attempts:4});`)).toBe(4);
});

test("the explicit-count integrity ceiling is not an omitted task budget", async () => {
  expect(await run(`
    const retried = await retry((index) => { if (index < 1001) throw new Error("again"); return index; });
    const gated = await gate((index) => index, (value) => value === 1001);
    const found = await loopUntilDry({key:"id", round:(index) => index <= 1001 ? [{id:index}] : []});
    return {retried, gated, found:found.length};
  `, {timeoutMs:5000})).toEqual({retried:1001, gated:1001, found:1001});
  expect(await run(`return gate((index) => index, (value) => value === 1000, {attempts:1000});`)).toBe(1000);
});

test("omitted runtime policy retains historical defaults", async () => {
  expect(await run(`
    let retries = 0;
    let gates = 0;
    try { await retry((attempt) => { retries = attempt; throw new Error("again"); }); } catch (error) {}
    try { await gate((attempt) => { gates = attempt; return attempt; }, () => false); } catch (error) {}
    const found = await loopUntilDry({key:"id", round:(index) => [{id:index}]});
    return { retries, gates, rounds:found.length };
  `, { helperPolicy: undefined })).toEqual({ retries: 3, gates: 3, rounds: 10 });
});

for (const value of ["0", "-1", "1.5", "null", "NaN", "Infinity", '"4"', "1001"]) {
  for (const body of [
      `return retry(() => { throw new Error("again"); }, {attempts:${value}});`,
      `return gate(() => 1, () => false, {attempts:${value}});`,
      `return loopUntilDry({key:"id", round:(index) => [{id:index}], maxRounds:${value}});`,
      `return loopUntilDry({key:"id", round:() => [], consecutiveEmpty:${value}});`,
  ]) {
    test(`invalid unlimited helper arguments reject instead of spinning: ${body}`, async () => {
      await expect(run(body, { timeoutMs: 1000 })).rejects.toThrow("safe positive integer");
    });
  }
}
for (const body of [
    `return retry(1);`, `return gate(1, () => true);`, `return gate(() => 1, false);`,
    `return gate(() => 1, () => ({truthy:true}));`,
    `return loopUntilDry({key:"id", round:() => 1});`,
    `return loopUntilDry({key:null, round:() => []});`,
]) {
  test(`invalid unlimited helper arguments reject instead of spinning: ${body}`, async () => {
    try { await run(body, { timeoutMs: 1000 }); throw new Error("unexpected success"); }
    catch (error) { expect(String(error)).not.toContain("timed out"); expect(String(error)).toMatch(/function|boolean|array/); }
  });
}

test("malformed gate verdicts fail immediately only under the new policy", async () => {
  const body = `let calls = 0; try { await gate(() => ++calls, () => ({truthy:true})); } catch (error) {} return calls;`;
  expect(await run(body)).toBe(1);
  expect(await run(body, {helperPolicy:undefined})).toBe(3);
});

test("real runner cancellation drains optional retry, gate and discovery after old counts", async () => {
  for (const body of [
    `return retry(async (index) => { await log(String(index)); throw new Error("again"); });`,
    `return gate(async (index) => { await log(String(index)); return index; }, () => false);`,
    `return loopUntilDry({key:"id", round:async (index) => { await log(String(index)); return [{id:index}]; }});`,
  ]) {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    let drained = false;
    const execution = run(body, {signal:controller.signal, host:{...host, log:async (message, signal) => {
      if (Number(message) < 13) return;
      started();
      try { await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), {once:true})); }
      finally { drained = true; }
    }}});
    const rejected = execution.catch((error: unknown) => error);
    await ready;
    controller.abort(new Error("cancel helpers"));
    expect(String(await rejected)).toContain("cancel helpers");
    expect(drained).toBe(true);
    expect(await run("return true;")).toBe(true);
  }
});

test("pure unbounded retries are terminable without any host call", async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("cancel pure retry")), 100);
  try { await expect(run(`return retry(() => { throw new Error("again"); });`, {signal:controller.signal})).rejects.toThrow("cancel pure retry"); }
  finally { clearTimeout(timer); }
});
