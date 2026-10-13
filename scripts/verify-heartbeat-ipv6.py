"""Verify the packaged runner against unchanged native IPv6 registration."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import uuid

import sandbox as module
from sandbox import Sandbox, eventually

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--package", type=Path, required=True)
parser.add_argument("--artifacts", type=Path, required=True)
options = parser.parse_args()
package = options.package.resolve()
artifacts = options.artifacts.resolve()
artifacts.mkdir(parents=True, exist_ok=False)
runner = package / "bin/op-threads-heartbeat.mjs"
binary = Path(shutil.which("opencode")).resolve()
version = subprocess.check_output([str(binary), "--version"], text=True).strip().removeprefix("opencode v")
registration_prefix = "http://::1:" if version == "2.0.26" else "http://[::1]:"
label = "com.opthreads.heartbeat.ipv6-" + uuid.uuid4().hex
config_file = artifacts / "runner.json"
domain = "gui/" + str(os.getuid())
sandbox = None
installed = False
started = time.monotonic()
receipt = {"accepted": False, "hostExecutable": str(binary), "hostSHA256": hashlib.sha256(binary.read_bytes()).hexdigest(), "runnerSHA256": hashlib.sha256(runner.read_bytes()).hexdigest(), "label": label, "checks": [], "commands": []}


def save():
    (artifacts / "receipt.json").write_text(json.dumps(receipt, indent=2))


def command(args):
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    receipt["commands"].append({"args": args, "exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr})
    save()
    return result


def cli(*args):
    result = command(["node", str(runner), *args, "--config", str(config_file)])
    assert result.returncode == 0, receipt["commands"][-1]
    return json.loads(result.stdout)


def check(name, value):
    assert value, name
    receipt["checks"].append(name)
    save()
    print("PASS:", name, flush=True)


def lines(name):
    path = artifacts / name
    return path.read_text().splitlines() if path.exists() else []


def runner_pid():
    result = command(["/bin/launchctl", "print", domain + "/" + label])
    assert result.returncode == 0
    return int(re.search(r"\bpid = (\d+)", result.stdout)[1])


class IPv6Sandbox(Sandbox):
    def start(self):
        self.env["OPENCODE_DISABLE_PROJECT_CONFIG"] = "true"
        self.password = None
        with socket.socket(socket.AF_INET6) as listener:
            listener.bind(("::1", 0))
            port = listener.getsockname()[1]
        self.url = f"http://[::1]:{port}"
        self.log = (self.artifacts / "server.log").open("ab")
        self.process = subprocess.Popen([self.binary, "serve", "--service", "--hostname", "::1", "--port", str(port)], cwd=self.directory, env=self.env, stdout=self.log, stderr=self.log)

        def healthy():
            if self.process.poll() is not None:
                raise RuntimeError("Native IPv6 fixture exited")
            service = self.root / "state/opencode/service.json"
            if not service.exists():
                return False
            data = json.loads(service.read_text())
            if data["pid"] != self.process.pid:
                return False
            self.password = data.get("password")
            try:
                return self.api("GET", "/api/info").get("version")
            except OSError:
                return False

        eventually(healthy, timeout=60)


try:
    original = module.tempfile.mkdtemp
    module.tempfile.mkdtemp = lambda prefix, dir: original(prefix=prefix, dir=artifacts)
    try:
        sandbox = IPv6Sandbox({"plugins": [str(package)], "snapshots": False, "providers": {}}, artifacts)
    finally:
        module.tempfile.mkdtemp = original
    sandbox.await_plugin()
    host = sandbox.root / "external-host"
    host.mkdir()
    service = sandbox.root / "state/opencode/service.json"
    before_bytes = service.read_bytes()
    before = json.loads(before_bytes)
    receipt["registration"] = {key: before[key] for key in ("pid", "version", "url")}
    receipt["directIPv6Health"] = sandbox.api("GET", "/api/info")
    receipt["listener"] = command(["/usr/sbin/lsof", "-nP", "-a", "-p", str(sandbox.process.pid), "-iTCP", "-sTCP:LISTEN"]).stdout
    check(f"unchanged native {version} writes its expected IPv6 registration", before["version"] == version and before["url"].startswith(registration_prefix))
    check("OS confirms an IPv6 loopback listener", "IPv6" in receipt["listener"] and "[::1]:" in receipt["listener"])
    cli("install", "--service-file", str(service), "--host-directory", str(host), "--label", label, "--launchagents-directory", str(artifacts / "agents"))
    installed = True
    eventually(lambda: len(lines("runner.log")) > 0)
    check("packaged external Node runner completes a real IPv6 tick", json.loads(lines("runner.log")[-1]) == {"protocol": 1, "shadow": False, "decisions": []})
    check("runner leaves the native registration byte-identical", service.read_bytes() == before_bytes)
    pid = runner_pid()
    receipt["runnerPID"] = pid
    before_ticks = len(lines("runner.log"))
    before_errors = len(lines("runner.error.log"))
    sandbox.stop()
    eventually(lambda: len(lines("runner.error.log")) > before_errors, timeout=80)
    check("same runner survives outage without starting a service", runner_pid() == pid and not service.exists() and sandbox.process.poll() is not None)
    check("outage tick reports connect-only failure", "connect-only" in json.loads(lines("runner.error.log")[-1])["unavailable"])
    sandbox.start()
    after_bytes = service.read_bytes()
    after = json.loads(after_bytes)
    receipt["refreshedRegistration"] = {key: after[key] for key in ("pid", "version", "url")}
    check("native restart refreshes IPv6 PID and URL", after["pid"] != before["pid"] and after["url"] != before["url"] and after["url"].startswith(registration_prefix))
    eventually(lambda: len(lines("runner.log")) > before_ticks, timeout=80)
    check("same external runner reconnects through fresh registration", runner_pid() == pid and json.loads(lines("runner.log")[-1]) == {"protocol": 1, "shadow": False, "decisions": []})
    check("refreshed registration remains byte-identical", service.read_bytes() == after_bytes)
    check("installed OpenCode executable remains unchanged", hashlib.sha256(binary.read_bytes()).hexdigest() == receipt["hostSHA256"])
    receipt["accepted"] = True
except BaseException as error:
    receipt["error"] = type(error).__name__ + ": " + str(error)
    raise
finally:
    try:
        if installed:
            cli("uninstall")
    except BaseException as error:
        receipt["accepted"] = False
        receipt["cleanupError"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        if sandbox:
            sandbox.stop()
            receipt["isolatedServiceStopped"] = sandbox.process.poll() is not None
        receipt["launcherAbsent"] = command(["/bin/launchctl", "print", domain + "/" + label]).returncode != 0
        receipt["accepted"] = receipt["accepted"] and receipt.get("isolatedServiceStopped", False) and receipt["launcherAbsent"]
        receipt["durationSeconds"] = time.monotonic() - started
        save()
        print(json.dumps(receipt, indent=2), flush=True)
