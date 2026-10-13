import hashlib
import json
import os
from pathlib import Path
import statistics
import sys
import threading
import time

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually


root = Path(__file__).resolve().parent.parent
baseline, refreshed, artifacts = map(lambda value: Path(value).resolve(), sys.argv[1:4])
artifacts.mkdir(parents=True, exist_ok=False)
measurements = []


def identity(target):
    return {str(path.relative_to(target)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in [target / "index.ts", target / "tui.ts", target / "tui.js", target / "package.json", *sorted((target / "src").glob("*"))]
            if path.is_file()}


def difference(after, before):
    return {key: difference(value, before.get(key, {})) if isinstance(value, dict) else value - before.get(key, 0)
            for key, value in after.items()}


def rpc(sandbox, name, value):
    return sandbox.api("POST", f"/api/rpc/native_load/{name}", {"input": value}, location=sandbox.directory)["output"]


def tool(sandbox, provider, owner, marker, name, arguments):
    provider.responses[marker] = {"name": name, "arguments": arguments}
    sandbox.api("POST", f"/api/session/{owner}/prompt", {"text": marker})
    def result():
        for message in sandbox.api("GET", f"/api/session/{owner}/message?limit=100")["data"]:
            for part in message.get("content", []):
                if part.get("type") == "tool" and part["name"] == name and part["state"]["status"] == "completed":
                    return json.loads(part["state"]["content"][0]["text"])
    output = eventually(result, timeout=60)
    eventually(lambda: owner not in sandbox.api("GET", "/api/session/active")["data"])
    return output


try:
    for variant, target in [("before", baseline), ("after", refreshed)]:
        hashes = identity(target)
        for saved_runs in [0, 120]:
            case = artifacts / f"{variant}-{saved_runs}"
            provider = Provider()
            sandbox = terminal = None
            try:
                settings = config(target, provider)
                settings["plugins"] = [{"package": str(root / "scripts/native-load-probe"), "options": {"target": str(target)}}]
                sandbox = Sandbox(settings, case)
                assert sandbox.api("GET", "/api/info")["version"] == "2.0.26"
                sandbox.await_plugin()
                cli_path = sandbox.root / "config/opencode/cli.json"
                cli = json.loads(cli_path.read_text())
                cli["plugins"][0]["options"]["tree"] = True
                cli["plugins"].append({"package": str(target)})
                cli_path.write_text(json.dumps(cli))
                owners = [sandbox.api("POST", "/api/session", {"title": f"Native load {name}", "location": {"directory": str(sandbox.directory)}})["data"]["id"] for name in ["A", "B"]]
                rpc(sandbox, "seed", {"owners": owners, "directory": str(sandbox.directory), "count": saved_runs})
                checkpoints = []
                for index, owner in enumerate(owners):
                    checkpoints.append(tool(sandbox, provider, owner, f"CHECKPOINT_{index}", "workflows_start", {
                        "key": f"load-checkpoint-{index}",
                        "script": f'export const meta = {{name:"load-checkpoint-{index}",description:"Real native checkpoint"}}; return await checkpoint("Load checkpoint", {{key:"load"}});',
                    }))
                (case / "identity.json").write_text(json.dumps({"target": str(target), "hashes": hashes, "sandbox": str(sandbox.root), "version": "2.0.26", "owners": owners, "checkpoints": checkpoints}, indent=2))
                for index, owner in enumerate(owners):
                    terminal = Terminal(sandbox, owner)
                    terminal.wait_for("Build · Fixture")
                    terminal.drain()
                    for panel in ["closed", "open"]:
                        if panel == "open":
                            os.write(terminal.master, b"/workflows")
                            terminal.wait_for("Open dynamic workflows")
                            os.write(terminal.master, b"\r")
                            terminal.wait_for("Dynamic workflows")
                            os.write(terminal.master, f"load-checkpoint-{index}".encode())
                            terminal.wait_for(f"load-checkpoint-{index}")
                            os.write(terminal.master, b"\r")
                            terminal.wait_for("Waiting: Load checkpoint")
                            terminal.drain()
                        marker = f"STREAM_{index}_{panel}"
                        provider.responses[marker] = {"stream": {"chunks": 600, "interval": 0.02}}
                        before = rpc(sandbox, "counts", {})
                        health = []
                        stop = threading.Event()
                        def sample():
                            while not stop.is_set():
                                started = time.monotonic()
                                try:
                                    version = sandbox.api("GET", "/api/info").get("version")
                                    health.append({"at": started, "ms": (time.monotonic() - started) * 1000, "version": version})
                                except Exception as error:
                                    health.append({"at": started, "error": str(error)})
                                stop.wait(0.05)
                        thread = threading.Thread(target=sample)
                        thread.start()
                        start = time.monotonic()
                        try:
                            sandbox.api("POST", f"/api/session/{owner}/prompt", {"text": marker})
                            terminal.wait_for_match(lambda _: any(receipt["marker"] == marker and "finished" in receipt for receipt in provider.streams), "real stream finished", 60, False)
                            eventually(lambda: owner not in sandbox.api("GET", "/api/session/active")["data"])
                            terminal.drain()
                        finally:
                            stop.set()
                            thread.join()
                        receipt = next(receipt for receipt in provider.streams if receipt["marker"] == marker)
                        loaded_health = [sample for sample in health if receipt["started"] <= sample["at"] <= receipt["finished"]]
                        messages = sandbox.api("GET", f"/api/session/{owner}/message?limit=100")["data"]
                        assert "token599" in json.dumps(messages), "Native host did not receive the entire stream"
                        assert receipt["sent"] == 600 and len(loaded_health) >= 10
                        assert all(sample.get("version") == "2.0.26" for sample in loaded_health), loaded_health
                        timings = sorted(sample["ms"] for sample in loaded_health)
                        after = rpc(sandbox, "counts", {})
                        measurement = {"variant": variant, "savedRuns": saved_runs, "nativeCheckpointRuns": 2, "owner": index, "panel": panel, "elapsedMs": (time.monotonic() - start) * 1000,
                                       "stream": receipt, "work": difference(after, before), "loadedHealth": loaded_health,
                                       "healthMedianMs": statistics.median(timings), "healthP95Ms": timings[int((len(timings) - 1) * 0.95)], "healthMaxMs": max(timings)}
                        measurements.append(measurement)
                        (case / f"owner-{index}-{panel}.json").write_text(json.dumps(measurement, indent=2))
                        (case / f"owner-{index}-{panel}.screen.txt").write_text("\n".join(terminal.screen.display))
                        print(variant, saved_runs, index, panel, json.dumps(measurement["work"]), flush=True)
                    terminal.close(case / f"owner-{index}.txt")
                    terminal = None
                assert identity(target) == hashes, "Measured source changed"
            finally:
                if terminal:
                    terminal.close(case / "terminal.txt")
                if sandbox:
                    sandbox.stop()
                provider.close()
                (case / "provider-streams.json").write_text(json.dumps(provider.streams, indent=2))
finally:
    (artifacts / "measurements.json").write_text(json.dumps(measurements, indent=2))

assert len(measurements) == 16, "Incomplete native matrix"
print(f"Completed {len(measurements)} native streaming windows", flush=True)
