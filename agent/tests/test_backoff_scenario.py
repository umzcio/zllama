"""The regressions this feature exists to prevent: an action retried forever.

Before failure backoff, a convergence action whose executor failed (an
installer that hung and was killed at its 10-minute timeout, exit 124) was
re-planned and re-attempted on *every* 30-second cycle, indefinitely — one
bad declaration turning into a permanent installer loop on a production
host. This file drives three consecutive cycles with the wall clock
advanced by one interval between them and asserts the executor ran exactly
once.

The second test covers the loop found by the first *live* convergence run: an
upgrade that reported success on every cycle while never actually changing the
serving version. Backoff keys on failure, so a success-loop was invisible to
it; the fix is that the executor no longer trusts exit 0.

Everything is faked: no subprocess, no HTTP, no real clock. The lock and
backoff-state paths are redirected into `tmp_path`, so this test never
touches `/var/lock` or `/var/lib`.
"""

import json
import time
from unittest.mock import MagicMock, patch

import zllama_agent.converge as converge_module
from zllama_agent.config import AgentConfig
from zllama_agent.converge import ExecutorResult, converge
from zllama_agent.executors import OLLAMA_EXECUTORS

INTERVAL_SECONDS = 30
START_EPOCH = 1_700_000_000.0

# What `executors._run` returns for a command killed at its timeout, and
# the timeout it would have been killed at (`executors.INSTALL_TIMEOUT_SECONDS`).
TIMEOUT_EXIT_CODE = 124
INSTALLER_TIMEOUT_SECONDS = 600

# The live upgrade that looped: declared 0.32.13, still serving 0.32.3.
DECLARED_VERSION = "0.32.13"
SERVING_VERSION = "0.32.3"


def test_a_failing_action_is_attempted_once_not_once_per_cycle(tmp_path, monkeypatch):
    clock = {"now": START_EPOCH}
    monkeypatch.setattr(time, "time", lambda: clock["now"])
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(tmp_path / "converge.lock"))
    monkeypatch.setattr(
        converge_module, "BACKOFF_STATE_PATH", str(tmp_path / "backoff.json"), raising=False
    )

    config = AgentConfig(
        server="https://zllama.example",
        node_name="node-a",
        token="fake-token",
        interval_seconds=INTERVAL_SECONDS,
        converge=True,
        log_level="info",
    )
    desired = {"runtimes": {"ollama": {"state": "present", "version": "0.32.13", "models": []}}}

    calls = []

    def hung_installer(action):
        calls.append(action)
        # A hung installer burns its whole timeout before being killed, so
        # the clock moves while it runs. That is the case backoff has to
        # handle correctly: the cooldown starts when the action actually
        # failed, not ten minutes earlier when the cycle began.
        clock["now"] += INSTALLER_TIMEOUT_SECONDS
        return ExecutorResult(
            exit_code=TIMEOUT_EXIT_CODE,
            stdout="",
            stderr=f"timed out after {INSTALLER_TIMEOUT_SECONDS}s",
            duration_ms=INSTALLER_TIMEOUT_SECONDS * 1000,
        )

    executors = {"ollama": {"install_runtime": hung_installer}}

    statuses = []
    for _ in range(3):
        result = converge(
            config,
            desired,
            # The install never succeeded, so the runtime is still absent
            # and the same action is planned again every cycle. Planning is
            # deliberately unchanged by backoff — only execution is gated.
            {},
            executors,
            dry_run=False,
            remote_converge=True,
        )
        statuses.append(result.status)
        clock["now"] += INTERVAL_SECONDS

    assert len(calls) == 1, (
        f"executor was invoked {len(calls)} times across 3 cycles; "
        "a failed action must be attempted once and then backed off"
    )
    assert statuses == ["failed", "cooling_down", "cooling_down"]


def _api_version_body(version):
    """A stand-in for what `urlopen` yields for `GET /api/version`."""
    response = MagicMock()
    response.read.return_value = json.dumps({"version": version}).encode("utf-8")
    context = MagicMock()
    context.__enter__.return_value = response
    return context


def _ollama_commands(args, **_kwargs):
    """Every command the real Ollama upgrade path issues, all succeeding.

    The installer (a shell string) exits 0, the unit exists, and the restart
    exits 0 — exactly what the live host reported. Nothing here is real: no
    shell, no systemd, no installer.
    """
    result = MagicMock()
    result.returncode = 0
    result.stdout = "installed" if isinstance(args, str) else ""
    result.stderr = ""
    return result


def test_an_upgrade_whose_postcondition_never_holds_is_attempted_once_not_once_per_cycle(
    tmp_path, monkeypatch
):
    """The second loop this feature has to close, found by the first live run.

    A host running ollama 0.32.3 was declared 0.32.13. The installer exited 0
    every time — but Ollama's installer does not restart a running service,
    so `/api/version` kept answering 0.32.3, planning kept re-planning the
    upgrade, and the executor kept reporting "succeeded". Backoff keys on
    failure, so a success-loop was invisible to it: the installer ran 13
    times in 12 minutes.

    This drives the *real* executor (with subprocess and HTTP faked) through
    three cycles with the serving version never changing. Because the
    executor now fails its post-condition instead of trusting exit 0, backoff
    engages and the installer runs exactly once.
    """
    clock = {"now": START_EPOCH}
    monkeypatch.setattr(time, "time", lambda: clock["now"])
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(tmp_path / "converge.lock"))
    monkeypatch.setattr(
        converge_module, "BACKOFF_STATE_PATH", str(tmp_path / "backoff.json"), raising=False
    )

    config = AgentConfig(
        server="https://zllama.example",
        node_name="node-a",
        token="fake-token",
        interval_seconds=INTERVAL_SECONDS,
        converge=True,
        log_level="info",
    )
    desired = {"runtimes": {"ollama": {"state": "present", "version": DECLARED_VERSION}}}
    # The host keeps serving the old version no matter how many times the
    # installer runs — which is precisely why it is re-planned every cycle.
    actual = {"ollama": {"version": SERVING_VERSION}}

    calls = []

    def counting_executor(action):
        calls.append(action)
        return OLLAMA_EXECUTORS["upgrade_runtime"](action)

    executors = {"ollama": {"upgrade_runtime": counting_executor}}

    statuses = []
    with (
        patch("zllama_agent.executors.shutil.which", return_value="/usr/bin/systemctl"),
        patch("zllama_agent.executors.subprocess.run", side_effect=_ollama_commands) as run,
        patch(
            "urllib.request.urlopen",
            return_value=_api_version_body(SERVING_VERSION),
        ),
    ):
        for _ in range(3):
            result = converge(
                config,
                desired,
                actual,
                executors,
                dry_run=False,
                remote_converge=True,
            )
            statuses.append(result.status)
            clock["now"] += INTERVAL_SECONDS

    installer_runs = [call for call in run.call_args_list if isinstance(call.args[0], str)]

    assert len(calls) == 1, (
        f"executor was invoked {len(calls)} times across 3 cycles; an upgrade "
        "whose post-condition never holds must be attempted once and then "
        "backed off"
    )
    assert len(installer_runs) == 1, (
        f"the official installer ran {len(installer_runs)} times across 3 "
        "cycles; this is the 13-in-12-minutes loop the post-condition check "
        "exists to make structurally impossible"
    )
    assert statuses == ["failed", "cooling_down", "cooling_down"], (
        "an install that exits 0 while the runtime keeps serving the old "
        "version is a failure, not a success; reporting 'succeeded' is what "
        "hid the loop from backoff"
    )
