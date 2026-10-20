"""Real tools, installed exact tarball, synthetic localhost model, task-owned service only."""
import argparse
import json
import traceback

from lite_fixture import LiteFixture, attempt
from sandbox import eventually


def verify(h):
    owner = h.create("Lite recovery coordinator")
    stranger = h.create("Lite unrelated coordinator")
    original = {"verdict": "PASS WITH NOTES", "summary": "Original immutable fixture report", "evidence": ["synthetic fixture, not a real model trial"]}
    h.provider.responses["LITE_INITIAL_REPORT"] = {"name": "threads_report", "arguments": original, "wait": True}
    request = {"key": "lite-worker", "title": "Lite recovery worker", "directory": str(h.sandbox.worker), "task": "LITE_INITIAL_REPORT"}
    spawned = h.tool(owner, "threads_spawn", request)
    worker = spawned["workerID"]
    h.sessions.append(worker)
    again = h.tool(owner, "threads_spawn", request)
    assert again["workerID"] == worker
    h.tool(owner, "threads_spawn", {**request, "task": "Changed task"}, status="error")
    roots = h.sandbox.api("GET", "/api/session?parentID=null&limit=100")["data"]
    assert {session["id"] for session in roots} == set(h.sessions), roots
    assert len([message for message in h.messages(worker) if message["type"] == "user"]) == 1
    h.passed("identical spawn reuses native worker and initial prompt; changed payload conflicts")
    h.provider.release.set()
    eventually(lambda: h.tools(worker, "threads_report"), timeout=60)
    h.idle(worker)
    assert len(h.tools(worker, "threads_report")) == 1
    initial_link = h.sandbox.api("GET", f"/api/session/{worker}")["data"]["metadata"]["opThreads"]

    def unchanged():
        snapshot = h.snapshot(owner)
        assert snapshot["configuration"] == {"mode": "lite", "directory": str(h.sandbox.directory)}, snapshot
        view = next(row for row in snapshot["workers"] if row["workerID"] == worker)
        assert view["report"] == original, view
        assert h.sandbox.api("GET", f"/api/session/{worker}")["data"]["metadata"]["opThreads"] == initial_link
        assert len(h.tools(worker, "threads_report")) == 1, "Follow-ups must not call a second report"
        return view

    unchanged()
    h.tool(stranger, "threads_send", {"workerID": worker, "key": "foreign", "text": "Not owned"}, status="error")
    h.tool(stranger, "threads_interrupt", {"workerID": worker}, status="error")
    h.tool(stranger, "threads_hide", {"workerID": worker}, status="error")
    h.tool(stranger, "threads_report", original, status="error")
    h.passed("unrelated sessions cannot send, interrupt, hide, or impersonate a managed report")

    def notices(message_id):
        return [message for message in h.messages(owner) if message["type"] == "synthetic"
                and message.get("metadata", {}).get("opThreadsFollowup", {}).get("messageID") == message_id]

    def admission(message_id):
        promoted = [message for message in h.messages(worker) if message["id"] == message_id and message["type"] == "synthetic"]
        queued = [item for item in h.inbox(worker) if item["id"] == message_id]
        assert len(promoted) + len(queued) == 1, {"promoted": promoted, "queued": queued}
        return promoted or queued

    def completed(message_id, outcome=None):
        notice = eventually(lambda: notices(message_id), timeout=60)
        h.idle(owner)
        assert len(notices(message_id)) == 1
        queued_notices = [item for item in h.inbox(owner)
                          if item.get("payload", {}).get("metadata", {}).get("opThreadsFollowup", {}).get("messageID") == message_id]
        assert not queued_notices, {"promoted": notices(message_id), "queued": queued_notices}
        metadata = notice[0]["metadata"]["opThreadsFollowup"]
        assert metadata["workerID"] == worker
        if outcome:
            assert metadata["outcome"] == outcome, metadata
        idle = next(message for message in h.messages(worker) if message["id"] == metadata["idleMessageID"])
        assert idle["type"] == "idle" and idle["outcome"] == metadata["outcome"], idle
        assert "Native completion is not a verdict" in notice[0]["text"]
        admission(message_id)
        unchanged()
        return metadata

    success = {"workerID": worker, "key": "success", "text": "LITE_FOLLOWUP_SUCCESS"}
    h.provider.responses[success["text"]] = {"stream": {"chunks": 3, "interval": 0.05}}
    sent = h.tool(owner, "threads_send", success)
    assert sent["workerID"] == worker
    completed(sent["messageID"], "succeeded")
    assert h.tool(owner, "threads_send", success) == sent
    h.tool(owner, "threads_send", {**success, "text": "Changed follow-up"}, status="error")
    completed(sent["messageID"], "succeeded")
    h.passed("identical send keeps message ID and one admission/notification; changed text conflicts")

    failed = {"workerID": worker, "key": "failed", "text": "LITE_FOLLOWUP_FAILURE"}
    h.provider.responses[failed["text"]] = {"error_always": True}
    sent_failed = h.tool(owner, "threads_send", failed)
    completed(sent_failed["messageID"], "failed")
    h.passed("failed follow-up native outcome does not replace the original report verdict")

    interrupted = {"workerID": worker, "key": "interrupted", "text": "LITE_FOLLOWUP_INTERRUPT"}
    h.provider.responses[interrupted["text"]] = {"stream": {"chunks": 600, "interval": 0.1}}
    sent_interrupted = h.tool(owner, "threads_send", interrupted)
    eventually(lambda: any(stream["marker"] == interrupted["text"] and stream["sent"] > 0 for stream in h.provider.streams))
    h.tool(owner, "threads_interrupt", {"workerID": worker})
    completed(sent_interrupted["messageID"], "interrupted")
    h.passed("real interrupt produces a separate native interrupted outcome, never a second report")

    pending = {"workerID": worker, "key": "restart-pending", "text": "LITE_FOLLOWUP_RESTART"}
    h.provider.responses[pending["text"]] = {"stream": {"chunks": 900, "interval": 0.1}}
    sent_pending = h.tool(owner, "threads_send", pending)
    eventually(lambda: any(stream["marker"] == pending["text"] and stream["sent"] > 0 for stream in h.provider.streams))
    assert worker in h.sandbox.api("GET", "/api/session/active")["data"]
    assert notices(sent_pending["messageID"]) == []
    before = {"send": sent_pending, "admission": admission(sent_pending["messageID"]), "link": initial_link,
              "notices": notices(sent_pending["messageID"]), "workerMessages": h.messages(worker), "snapshot": h.snapshot(owner)}
    (h.artifacts / "before-restart.json").write_text(json.dumps(before, indent=2))
    # Kill only our exact subprocess: leave no in-process follow-up watcher to settle the record.
    process = h.sandbox.process
    process.kill()
    process.wait(timeout=10)
    h.sandbox.stop()
    (h.artifacts / "restart.json").write_text(json.dumps({"ownedKilledPID": process.pid, "exitCode": process.returncode}, indent=2))
    # OpenCode resumes its own interrupted native turn. Make that continuation finite;
    # this is not a second threads_send or a claim of exactly-once model execution.
    h.provider.responses[pending["text"]] = {"stream": {"chunks": 3, "interval": 0.05}}
    h.sandbox.start()
    h.sandbox.await_plugin()
    eventually(lambda: len([stream for stream in h.provider.streams if stream["marker"] == pending["text"]]) == 2)
    h.idle(worker)
    # Pure readback is not recovery and must not manufacture a completion notice.
    assert notices(sent_pending["messageID"]) == []
    admission(sent_pending["messageID"])
    (h.artifacts / "after-restart-before-reconcile.json").write_text(json.dumps({"snapshot": h.snapshot(owner), "workerMessages": h.messages(worker)}, indent=2))
    listed = h.tool(owner, "threads_list", {})  # production context hook + bounded follow-up reconciliation
    assert next(view for view in listed["workers"] if view["workerID"] == worker)["report"] == original
    recovered = completed(sent_pending["messageID"])
    assert recovered["outcome"] in ["succeeded", "interrupted", "failed"], recovered
    assert h.tool(owner, "threads_send", pending) == sent_pending
    h.tool(owner, "threads_list", {})
    completed(sent_pending["messageID"])
    (h.artifacts / "recovered.json").write_text(json.dumps({"send": sent_pending, "completion": recovered,
        "admissions": len(admission(sent_pending["messageID"])), "notifications": len(notices(sent_pending["messageID"])), "snapshot": h.snapshot(owner)}, indent=2))
    h.passed("restart pending follow-up reconciles only through production Lite context, preserving IDs and one notification")
    assert len([m for m in h.messages(owner) if m["type"] == "synthetic" and "Original immutable fixture report" in m.get("text", "")]) == 1
    h.tool(owner, "threads_hide", {"workerID": worker})
    unchanged()
    names = {tool["function"]["name"] for request in h.provider.requests for tool in request.get("tools", [])}
    assert {name for name in names if name.startswith("threads_")} == {"threads_spawn", "threads_list", "threads_send", "threads_interrupt", "threads_hide", "threads_report"}
    assert not any(name.startswith("workflows_") for name in names), names
    h.passed("all six installed Lite tools exercised; no workflow tools exposed and original report retained")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tarball")
    parser.add_argument("--artifacts", help="New directory only; failures and original attempts are never overwritten")
    args = parser.parse_args()
    artifacts, plugin = attempt(args.tarball, args.artifacts, "recovery")
    print("Artifacts: " + str(artifacts), flush=True)
    harness = None
    try:
        harness = LiteFixture(plugin, artifacts / "native")
        verify(harness)
        harness.status = "PASS"
    except BaseException:
        failure = traceback.format_exc()
        (artifacts / "failure.txt").write_text(failure)
        if harness:
            harness.status, harness.failure = "FAIL", failure
        raise
    finally:
        if harness:
            harness.close()
