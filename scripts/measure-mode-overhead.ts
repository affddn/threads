import { z } from "zod";
import { serverHarness } from "../test/support/server-harness";

// Static registration bytes, not model tokens or runtime performance.
const result = await serverHarness(process.argv[2] === "default" ? {} : { mode: process.argv[2] ?? "lite" });
try {
  const descriptions = result.tools.map((tool) => tool.description);
  const schemas = result.tools.map((tool) => ({
    input: tool.input instanceof z.ZodType ? z.toJSONSchema(tool.input, { unrepresentable: "any", io: "input" }) : tool.input,
    output: tool.output instanceof z.ZodType ? z.toJSONSchema(tool.output, { unrepresentable: "any" }) : tool.output ?? null,
  }));
  console.log(JSON.stringify({
    tools: result.tools.map((tool) => `${tool.options?.namespace}_${tool.name}`),
    descriptionBytes: descriptions.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    schemaBytes: schemas.reduce((sum, schema) => sum + Buffer.byteLength(JSON.stringify(schema)), 0),
    hooks: result.hooks.length, skills: result.skills.length, commands: result.commands.length,
    rpcs: result.rpcs,
  }));
} finally { if (typeof result.dispose === "function") await result.dispose(); }
