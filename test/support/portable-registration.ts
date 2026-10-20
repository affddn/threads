import { serverHarness } from "./server-harness";

const result = await serverHarness({ mode: process.argv[2] });
try {
  console.log(JSON.stringify({
    tools: result.tools.map(({ name, description, options }) => ({ name, description, namespace: options?.namespace })),
    skills: result.skills,
  }));
} finally { if (typeof result.dispose === "function") await result.dispose(); }
