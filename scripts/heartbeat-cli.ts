#!/usr/bin/env node
import { heartbeatCli } from "../src/heartbeat-runner";
try { const output = await heartbeatCli(); process.stdout.write(`${JSON.stringify(output)}\n`); }
catch (error) { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; }
