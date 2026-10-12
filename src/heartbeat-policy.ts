import type { WorkflowRun } from "./workflow-types";
import { HeartbeatView, type HeartbeatObservation, type HeartbeatRecord } from "./heartbeat-types";
import type { RawRun } from "./heartbeat-rpc";
import type { z } from "zod";

export function heartbeatDecision(record: HeartbeatRecord, run: WorkflowRun | undefined, observation: HeartbeatObservation | undefined, now: number): HeartbeatView["decision"] {
  return heartbeatProjectionDecision(record, run && { ...run, sessionIDs: run.steps.map((step) => step.workerID) }, observation, now);
}

export function heartbeatProjectionDecision(record: HeartbeatRecord, run: z.infer<typeof RawRun> | undefined, observation: HeartbeatObservation | undefined, now: number): HeartbeatView["decision"] {
  const hold = (reason: string): HeartbeatView["decision"] => ({ kind: "hold", reason });
  if (record.mode === "stopped") return { kind: "stopped", reason: "explicit stop; not a workflow verdict" };
  if ((record.deadlineAt !== undefined && now >= record.deadlineAt) || record.mode === "expired") return { kind: "expired", reason: "absolute deadline" };
  if (now < record.lastClockAt) return hold("clock rollback");
  if (record.mode === "suspended") return hold("suspended");
  if (record.pendingAdmission) return hold("unresolved admission; read-only reconciliation only");
  if (record.policy.maxWakes !== undefined && record.wakesReserved >= record.policy.maxWakes) return hold("lifetime wake cap");
  if (now < record.nextWakeAt) return hold("cooldown");
  if (!run || run.id !== record.binding.runID || run.ownerID !== record.ownerID || run.projectID !== record.binding.projectID || run.directory !== record.binding.directory || run.fingerprint !== record.binding.runFingerprint) return hold("raw run unavailable or binding mismatch");
  const lifecycleInspection = run.status === "interrupted" && run.interruption !== undefined
    && run.interruption.at <= now && run.interruption.at <= run.updated
    && run.sessionIDs.length === 0 && run.checkpoints.some((item) => item.response === undefined);
  if (!["running", "waiting"].includes(run.status) && !lifecycleInspection) return hold(`workflow ${run.status}; interruption intent is not inferred`);
  if (run.checkpoints.some((item) => item.response === undefined && item.reviewer !== "coordinator")) return hold("human or legacy checkpoint");
  if (!observation || observation.kind === "unavailable") return hold(observation?.reason ?? "observation unavailable");
  if (observation.at > now || now - observation.at > 30_000) return hold("stale observation");
  if (observation.ownerID !== record.ownerID || observation.runID !== run.id || observation.directory !== run.directory) return hold("observation scope mismatch");
  const owner = observation.sessions.find((item) => item.id === record.ownerID);
  if (!owner || owner.projectID !== run.projectID) return hold("owner observation unavailable");
  if (run.sessionIDs.some((id) => !observation.sessions.some((item) => item.id === id))) return hold("worker observation incomplete");
  for (const item of observation.sessions) {
    if (item.permission || item.form || item.queued || item.revert || item.interrupted) return hold("input, permission, form, revert or interruption hold");
  }
  if (owner.busy) return hold("owner busy");
  if (now - owner.idleAt < record.policy.idleGraceMs) return hold("idle grace");
  if (now - run.updated < record.policy.stalledMs) return hold("progress grace");
  return { kind: "wake", reason: "idle owner; stalled recorded progress" };
}

export function heartbeatView(record: HeartbeatRecord, decision: HeartbeatView["decision"]): HeartbeatView {
  return HeartbeatView.parse(JSON.parse(JSON.stringify({ ...record, wakesRemaining: record.policy.maxWakes === undefined ? null : Math.max(0, record.policy.maxWakes - record.wakesReserved), decision })));
}

export function heartbeatReminder(record: HeartbeatRecord): string {
  return `Heartbeat inspection reminder for workflow ${record.binding.runID} (monitor ${record.monitorID}). Inspect recorded progress and blockers. This reminder grants no recovery, control, checkpoint response, permission reply, or acceptance authority. Use your task instructions and report actual evidence; expiry or monitoring stop is not task success.`;
}
