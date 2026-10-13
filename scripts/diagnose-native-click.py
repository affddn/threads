import json
import os
import sys
import time
from pathlib import Path

from fixture import Provider, config
from sandbox import Sandbox, Terminal, eventually

root = Path(__file__).resolve().parent.parent
artifacts = Path(sys.argv[1]).resolve()
artifacts.mkdir(parents=True, exist_ok=False)
provider = Provider()
sandbox = terminal = None
try:
    sandbox = Sandbox(config(root, provider), artifacts)
    sandbox.await_plugin()
    cli_path = sandbox.root / "config/opencode/cli.json"
    cli = json.loads(cli_path.read_text())
    cli["plugins"][0]["options"]["tree"] = True
    cli_path.write_text(json.dumps(cli))
    owner = sandbox.api("POST", "/api/session", {"title": "Click probe", "location": {"directory": str(sandbox.directory)}})["data"]["id"]
    provider.responses["CLICK_PROBE"] = {"name": "workflows_start", "arguments": {
        "key": "click-probe", "script": 'export const meta = {name:"click-probe", description:"Native click diagnosis"}; return await checkpoint("Click proof", {key:"proof"});',
    }}
    sandbox.api("POST", f"/api/session/{owner}/prompt", {"text": "CLICK_PROBE"})
    eventually(lambda: owner not in sandbox.api("GET", "/api/session/active")["data"])
    terminal = Terminal(sandbox, owner)
    terminal.wait_for("Build · Fixture")
    os.write(terminal.master, b"\x18b")
    terminal.wait_for("click-probe")
    def find(node):
        if node.get("id", "").startswith("threads-sidebar-workflow-"):
            return node
        return next((found for child in node["children"] if (found := find(child))), None)
    nodes = []
    def ready(_):
        try:
            node = find(json.loads((artifacts / "tabs.json.tree.json").read_text())["tree"])
            if node and node.get("width", 0) > 0:
                nodes.append(node)
                return True
        except (FileNotFoundError, json.JSONDecodeError):
            return False
    terminal.wait_for_match(ready, "sidebar row", 40, False)
    node = nodes[-1]
    (artifacts / "click-node.json").write_text(json.dumps(node, indent=2))
    for offset in [2, 4, 10]:
        x, y = node["x"] + offset, node["y"] + 1
        os.write(terminal.master, f"\x1b[<0;{x};{y}M\x1b[<0;{x};{y}m".encode())
        try:
            terminal.wait_for("Click proof", timeout=3)
            print("opened at offset", offset)
            break
        except TimeoutError:
            (artifacts / f"offset-{offset}.screen.txt").write_text("\n".join(terminal.screen.display))
            print("not opened at offset", offset)
    else:
        raise AssertionError("No sidebar click opened the checkpoint")
finally:
    if terminal:
        terminal.close(artifacts / "terminal.txt")
    if sandbox:
        sandbox.stop()
    provider.close()
