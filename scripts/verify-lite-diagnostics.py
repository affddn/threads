"""Visible installed-terminal mode diagnostics; isolated synthetic sessions only."""
import argparse
import json
import os
import re
import time
import traceback

from lite_fixture import LiteFixture, attempt
from sandbox import Terminal


def verify(h, plugin, server_mode, terminal_mode):
    owner = h.create("Lite diagnostic coordinator")
    spawned = h.tool(owner, "threads_spawn", {"key": "diagnostic-worker", "title": "Diagnostic worker", "directory": str(h.sandbox.worker), "task": "Synthetic diagnostic task, finish without tools."})
    h.sessions.append(spawned["workerID"])
    h.idle(spawned["workerID"])
    snapshot = h.snapshot(owner)
    assert snapshot["configuration"] == {"mode": server_mode or "full", "directory": str(h.sandbox.directory)}, snapshot
    cli_path = h.sandbox.root / "config" / "opencode" / "cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"] = [{"package": str(plugin), "options": {} if terminal_mode is None else {"mode": terminal_mode}}]
    cli_path.write_text(json.dumps(cli))
    terminal = None
    mismatch = (server_mode or "full") != (terminal_mode or "full")
    try:
        terminal = Terminal(h.sandbox, owner)
        terminal.wait_for("ctrl+p commands")
        if mismatch:
            terminal.wait_for("Threads mode mismatch")
            text = "\n".join(terminal.screen.display)
            (h.artifacts / "mismatch.screen.txt").write_text(text)
            # Read the toast rectangle, not the conversation painted behind it.
            header = next(line for line in terminal.screen.display if "Threads mode mismatch" in line)
            start = header.rfind("┃", 0, header.index("Threads mode mismatch")) + 1
            end = header.find("┃", header.index("Threads mode mismatch"))
            toast = "\n".join(line[start:end] for line in terminal.screen.display)
            flattened = re.sub(r"\s+", "", toast)
            assert f"terminal{terminal_mode};server{server_mode}" in flattened, text
            assert "atrespondingdirectory" in flattened, text
            assert str(h.sandbox.directory) in flattened, text
            h.passed("visible mismatch labels both modes and the actual responding directory")
        started = time.monotonic()
        terminal.wait_for_match(lambda _: time.monotonic() - started >= 7, "toast expiry and idle settle", 15, False)
        assert "Threads mode" not in "\n".join(terminal.screen.display)
        h.tool(owner, "threads_list", {})
        started = time.monotonic()
        terminal.wait_for_match(lambda _: time.monotonic() - started >= 2, "repeated lifecycle refresh", 10, False)
        assert "Threads mode" not in "\n".join(terminal.screen.display), "Mismatch warning repeated"
        if not mismatch:
            assert "Threads mode" not in terminal.text(), terminal.text()
        h.passed("matching/default mode is quiet; repeated snapshots do not repeat a mismatch toast")
        os.write(terminal.master, b"\x18j")
        terminal.wait_for("enter Open · esc Close")
        terminal.wait_for("Diagnostic worker")
        os.write(terminal.master, b"no-such-diagnostic-worker")
        terminal.wait_for("No matching conversations")
        os.write(terminal.master, b"\x15")
        terminal.wait_for("Diagnostic worker")
        (h.artifacts / "worker-list.screen.txt").write_text("\n".join(terminal.screen.display))
        os.write(terminal.master, b"\x1b")
        terminal.wait_for_match(lambda text: "enter Open · esc Close" not in text, "closed worker list", 10, False)
        h.passed("compiled installed worker list stays usable, including search and Escape")
    finally:
        if terminal:
            terminal.close(h.artifacts / "terminal.txt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tarball")
    parser.add_argument("--artifacts", help="New directory only")
    args = parser.parse_args()
    artifacts, plugin = attempt(args.tarball, args.artifacts, "diagnostics")
    print("Artifacts: " + str(artifacts), flush=True)
    for server_mode, terminal_mode in [("lite", "lite"), ("lite", "full"), ("full", "lite"), (None, None)]:
        name = f"server-{server_mode or 'default'}-terminal-{terminal_mode or 'default'}"
        harness = None
        try:
            harness = LiteFixture(plugin, artifacts / name, server_mode)
            verify(harness, plugin, server_mode, terminal_mode)
            harness.status = "PASS"
        except BaseException:
            failure = traceback.format_exc()
            (artifacts / f"failure-{name}.txt").write_text(failure)
            if harness:
                harness.status, harness.failure = "FAIL", failure
            raise
        finally:
            if harness:
                harness.close()
