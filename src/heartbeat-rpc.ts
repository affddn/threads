import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { HeartbeatObservation, HeartbeatRecord, HeartbeatView } from "./heartbeat-types";
import { WorkflowRun } from "./workflow-types";

export const RawRun = WorkflowRun.pick({ id: true, ownerID: true, projectID: true, directory: true, fingerprint: true, status: true, updated: true, checkpoints: true, interruption: true }).extend({ sessionIDs: z.array(z.string()).max(1_000) }).strict();
export const HeartbeatSnapshot = z.object({ record: HeartbeatRecord, run: RawRun.nullable(), unavailable: z.string().optional() }).strict();
export type HeartbeatSnapshot = z.infer<typeof HeartbeatSnapshot>;
export const SnapshotInput = z.object({ afterOwnerID: z.string().optional(), limit: z.number().int().min(1).max(100).default(100) }).strict();
export const SnapshotOutput = z.object({ protocol: z.literal(1), entries: z.array(HeartbeatSnapshot), next: z.string().optional() }).strict();
export const Apply = z.object({ ownerID: z.string(), monitorID: z.string(), expectedRevision: z.number().int(), bindingEpoch: z.number().int(), observation: HeartbeatObservation }).strict();
export const HeartbeatRpc = Rpc.define({ id: "workflows-heartbeat", methods: {
  snapshot: { input: SnapshotInput, output: SnapshotOutput, errors: {} },
  apply: { input: Apply, output: HeartbeatView, errors: {} },
}, events: {} });
