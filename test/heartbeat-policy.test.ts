import { expect, test } from "bun:test";
import { HeartbeatRecord, type HeartbeatObservation } from "../src/heartbeat-types";
import { heartbeatDecision } from "../src/heartbeat-policy";
import { heartbeatProjectionDecision } from "../src/heartbeat-policy";
import { WorkflowRun } from "../src/workflow-types";

export const now = 1_000_000;
export const run = WorkflowRun.parse({ version: 1, id: "run", key: "run", ownerID: "owner", callerAgent: "caller", model: { id: "model", providerID: "provider" }, projectID: "project", directory: "/project", name: "test", description: "test", script: "return null", args: null, fingerprint: "fingerprint", limits: {}, status: "running", created: 1, updated: 1, phase: "", steps: [], logs: [], checkpoints: [], deliveryID: "delivery", delivered: false });
export const record = HeartbeatRecord.parse({ key: "key", monitorID: "monitor", ownerID: "owner", revision: 0, enrollmentFingerprint: "fingerprint", binding: { epoch: 0, runID: "run", projectID: "project", directory: "/project", runFingerprint: "fingerprint" }, bindings: [], mode: "watching", deadlineAt: now + 100_000, policy: {}, wakesReserved: 0, sequence: 0, nextWakeAt: 0, lastClockAt: 0, pendingAdmission: null, admissions: [], history: [] });
export const observation: Extract<HeartbeatObservation, { kind: "complete" }> = { kind: "complete", at: now, ownerID: "owner", runID: "run", directory: "/project", sessions: [{ id: "owner", projectID: "project", busy: false, queued: false, permission: false, form: false, revert: false, interrupted: false, idleAt: 1 }], admission: null };

test("only running or explicit coordinator waiting can plan an inspection wake", () => {
  expect(heartbeatDecision(record, run, observation, now).kind).toBe("wake");
  for (const status of WorkflowRun.shape.status.options) {
    const result = heartbeatDecision(record, { ...run, status }, observation, now);
    expect(result.kind).toBe(["running", "waiting"].includes(status) ? "wake" : "hold");
  }
  for (const reviewer of [undefined, "human", "coordinator"] as const) {
    expect(heartbeatDecision(record, { ...run, status: "waiting", checkpoints: [{ key: "arbitrary", prompt: "review", reviewer }] }, observation, now).kind).toBe(reviewer === "coordinator" ? "wake" : "hold");
  }
});

test("known checkpoint-only lifecycle interruptions allow inspection but never override native or human holds", () => {
  for (const kind of ["engine-disposed", "lease-lost"] as const) {
    const eligible = { ...run, status: "interrupted" as const, interruption: { kind, priorStatus: "waiting" as const, at: 1 }, checkpoints: [{ key: "inspect", prompt: "Inspect", reviewer: "coordinator" as const }] };
    expect(heartbeatDecision(record, eligible, observation, now).kind).toBe("wake");
    for (const field of ["busy", "queued", "permission", "form", "revert", "interrupted"] as const) {
      const blocked = structuredClone(observation); blocked.sessions[0][field] = true;
      expect(heartbeatDecision(record, eligible, blocked, now).kind).toBe("hold");
    }
    expect(heartbeatDecision(record, { ...eligible, checkpoints: [{ key: "human", prompt: "Approve", reviewer: "human" }] }, observation, now).kind).toBe("hold");
    expect(heartbeatDecision(record, { ...eligible, interruption: undefined }, observation, now).kind).toBe("hold");
    expect(heartbeatDecision(record, { ...eligible, checkpoints: [] }, observation, now).kind).toBe("hold");
    expect(heartbeatProjectionDecision(record, { ...eligible, sessionIDs: ["unresolved-worker"] }, observation, now).kind).toBe("hold");
    expect(heartbeatDecision(record, { ...eligible, interruption: { ...eligible.interruption, at: now + 1 } }, observation, now).kind).toBe("hold");
    for (const status of ["paused", "pausing", "stopped", "stopping"] as const) expect(heartbeatDecision(record, { ...eligible, status }, observation, now).kind).toBe("hold");
  }
});

test("observed busy/input/permissions/forms/revert/interruptions in any traversed session hold", () => {
  for (const field of ["busy", "queued", "permission", "form", "revert", "interrupted"] as const) {
    const blocked = structuredClone(observation); blocked.sessions[0][field] = true;
    expect(heartbeatDecision(record, run, blocked, now).kind).toBe("hold");
    if (field !== "busy") {
      const descendant = structuredClone(observation); descendant.sessions.push({ ...observation.sessions[0], id: "native-child", parentID: "owner", [field]: true });
      expect(heartbeatDecision(record, run, descendant, now).kind).toBe("hold");
    }
  }
});

test("deadline, cap, cooldown, rollback, unavailable, wrong scope and human mixed checkpoint fail closed", () => {
  for (const patch of [{ mode: "suspended" as const }, { wakesReserved: 12, policy: { ...record.policy, maxWakes: 12 } }, { nextWakeAt: now + 1 }, { lastClockAt: now + 1 }]) expect(heartbeatDecision({ ...record, ...patch }, run, observation, now).kind).toBe("hold");
  expect(heartbeatDecision({ ...record, deadlineAt: now }, run, observation, now).kind).toBe("expired");
  expect(heartbeatDecision({ ...record, mode: "stopped" }, run, observation, now).kind).toBe("stopped");
  for (const obs of [undefined, { kind: "unavailable", at: now, reason: "no service" } as const, { ...observation, at: now - 30_001 }, { ...observation, ownerID: "other" }]) expect(heartbeatDecision(record, run, obs, now).kind).toBe("hold");
  expect(heartbeatDecision(record, { ...run, checkpoints: [{ key: "a", prompt: "a", reviewer: "coordinator" }, { key: "b", prompt: "b" }] }, observation, now).kind).toBe("hold");
});
