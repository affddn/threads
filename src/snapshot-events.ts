// Streamed content does not change worker reports or workflow journals. Lifecycle,
// metadata and attention events still trigger reads; polling covers journal-only updates.
const streamedContent = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.tool.input.delta",
  "session.compaction.delta",
  "session.step.streamed",
  "session.tool.progress",
]);

export function snapshotEvent(type: string) {
  return (type.startsWith("session.") && !streamedContent.has(type))
    || type.startsWith("permission.") || type.startsWith("form.");
}
