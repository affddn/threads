"""Installed-only Lite verification support. No production storage or model access."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import traceback
import uuid
from datetime import datetime, timezone

from fixture import Provider, config
from sandbox import Sandbox, eventually


def attempt(target, artifacts, label):
    target = Path(target).resolve()
    if not target.is_file() or target.suffix != ".tgz":
        raise ValueError("Pass an exact npm .tgz, never a source checkout or extracted directory")
    root = Path(__file__).resolve().parent.parent
    directory = Path(artifacts).resolve() if artifacts else root / ".audit" / "lite-followups" / (label + "-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    directory.mkdir(parents=True, exist_ok=False)
    print("Retained attempt: " + str(directory), flush=True)
    digest = hashlib.sha512(target.read_bytes()).hexdigest()
    retained = directory / "package.tgz"
    shutil.copyfile(target, retained)
    assert hashlib.sha512(retained.read_bytes()).hexdigest() == digest
    (directory / "artifact.json").write_text(json.dumps({"path": str(target), "retained": str(retained), "sha512": digest, "bytes": target.stat().st_size}, indent=2))
    install = directory / "install"
    install.mkdir()
    home = directory / "install-home"
    home.mkdir()
    env = {"PATH": os.environ["PATH"], "HOME": str(home)}
    for kind in ["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"]:
        path = home / kind.lower()
        path.mkdir(mode=0o700)
        env[f"XDG_{kind}_HOME" if kind != "RUNTIME" else "XDG_RUNTIME_DIR"] = str(path)
    (install / "package.json").write_text(json.dumps({"private": True, "dependencies": {"@op1/threads": "file:" + str(retained)}}))
    command = ["bun", "install", "--production", "--ignore-scripts"]
    (directory / "install-command.json").write_text(json.dumps({"command": command, "cwd": str(install), "environment": env}, indent=2))
    try:
        with (directory / "install.log").open("w") as log:
            subprocess.run(command, cwd=install, env=env, stdout=log, stderr=log, check=True)
    except BaseException:
        (directory / "install-failure.txt").write_text(traceback.format_exc())
        raise
    assert hashlib.sha512(target.read_bytes()).hexdigest() == digest, "Tarball changed during installation"
    plugin = install / "node_modules" / "@op1" / "threads"
    assert (plugin / "tui.js").is_file() and not (plugin / "tui.ts").exists(), "Tarball must contain compiled terminal entry only"
    return directory, plugin


class LiteFixture:
    def __init__(self, plugin, artifacts, mode="lite"):
        self.artifacts = artifacts
        self.artifacts.mkdir(parents=True, exist_ok=True)
        self.provider = Provider()
        self.sandbox = None
        self.sessions = []
        self.calls = []
        self.checks = []
        self.status = "INCONCLUSIVE"
        self.failure = None
        self.version = None
        try:
            settings = config(plugin, self.provider)
            settings["plugins"] = [{"package": str(plugin), "options": {} if mode is None else {"mode": mode}}]
            (artifacts / "configuration.json").write_text(json.dumps(settings, indent=2))
            self.sandbox = Sandbox(settings, artifacts, root_dir=artifacts)
            self.sandbox.await_plugin()
            self.version = self.sandbox.api("GET", "/api/info")["version"]
        except BaseException:
            self.close()
            raise

    def passed(self, label):
        self.checks.append(label)
        print("PASS: " + label, flush=True)

    def create(self, title):
        result = self.sandbox.api("POST", "/api/session", {"title": title, "location": {"directory": str(self.sandbox.directory)}})["data"]
        self.sessions.append(result["id"])
        return result["id"]

    def messages(self, session):
        assert session in self.sessions, "Unowned session"
        messages = self.sandbox.api("GET", f"/api/session/{session}/message?limit=100")["data"]
        assert len(messages) < 100, "Bounded fixture exceeded message readback coverage; paginate before extending this suite"
        return messages

    def inbox(self, session):
        assert session in self.sessions, "Unowned session"
        return self.sandbox.api("GET", f"/api/session/{session}/inbox")["data"]

    def tools(self, session, name):
        return [part for message in self.messages(session) if message["type"] == "assistant"
                for part in message["content"] if part["type"] == "tool" and part["name"] == name
                and part["state"]["status"] in ["completed", "error"]]

    def idle(self, session):
        eventually(lambda: session not in self.sandbox.api("GET", "/api/session/active")["data"], timeout=60)

    def tool(self, session, name, arguments, status="completed"):
        marker = "LITE_CALL_" + uuid.uuid4().hex
        self.provider.responses[marker] = {"name": name, "arguments": arguments}
        before = {part["id"] for part in self.tools(session, name)}
        call = {"sessionID": session, "name": name, "arguments": arguments, "marker": marker}
        self.calls.append(call)
        self.sandbox.api("POST", f"/api/session/{session}/prompt", {"text": marker})
        result = eventually(lambda: next((part for part in self.tools(session, name) if part["id"] not in before), None), timeout=60)
        call["result"] = result
        self.idle(session)
        assert result["state"]["status"] == status, result
        if status == "error":
            return result
        return json.loads(next(part["text"] for part in result["state"]["content"] if part["type"] == "text"))

    def snapshot(self, owner):
        assert owner in self.sessions
        return self.sandbox.api("POST", "/api/rpc/threads/snapshot", {"input": {"coordinatorIDs": [owner]}}, location=self.sandbox.directory)["output"]

    def close(self):
        cleanup = []
        if self.sandbox:
            try:
                for session in self.sessions:
                    try:
                        (self.artifacts / f"messages-{session}.json").write_text(json.dumps(self.messages(session), indent=2))
                        (self.artifacts / f"inbox-{session}.json").write_text(json.dumps(self.inbox(session), indent=2))
                    except Exception as error:
                        cleanup.append({"session": session, "readbackError": str(error)})
            finally:
                process = self.sandbox.process
                self.sandbox.stop()
                cleanup.append({"ownedServicePID": process.pid if process else None, "exitCode": process.poll() if process else None})
        self.provider.close()
        cleanup.append({"providerThreadStopped": not self.provider.thread.is_alive()})
        (self.artifacts / "calls.json").write_text(json.dumps(self.calls, indent=2))
        (self.artifacts / "provider-requests.json").write_text(json.dumps(self.provider.requests, indent=2))
        (self.artifacts / "provider-streams.json").write_text(json.dumps(self.provider.streams, indent=2))
        (self.artifacts / "results.json").write_text(json.dumps({"status": self.status, "checks": self.checks, "failure": self.failure,
            "serviceVersion": self.version, "calls": len(self.calls), "providerRequests": len(self.provider.requests), "syntheticTokenCountsOnly": True, "cleanup": cleanup}, indent=2))
