"""Tests for failure backoff: the memory that stops one failed action from
becoming an infinite retry loop.

Everything here is faked — no subprocess, no HTTP, no real clock, no sleeps.
Time is injected through `converge(clock=...)` (a callable, not a fixed
timestamp, because an executor can burn ten minutes before failing), and the
state file lives in `tmp_path`. `tests/conftest.py` additionally redirects
`BACKOFF_STATE_PATH` and `LOCK_PATH` away from the host's real `/var` for
every test in this suite.
"""

import json
from unittest.mock import MagicMock, patch

import zllama_agent.backoff as backoff_module
import zllama_agent.converge as converge_module
from zllama_agent.backoff import (
    MAX_DELAY_SECONDS,
    BackoffEntry,
    BackoffState,
    delay_for,
    fingerprint,
)
from zllama_agent.config import AgentConfig
from zllama_agent.converge import Action, ExecutorResult, converge
from zllama_agent.main import _serialize_result
from zllama_agent.models import DiskVerdict

START = 1_700_000_000.0


def make_config(converge_flag: bool = True) -> AgentConfig:
    return AgentConfig(
        server="https://zllama.example",
        node_name="node-a",
        token="super-secret-token",
        interval_seconds=30,
        converge=converge_flag,
        log_level="info",
    )


class FakeClock:
    """An injectable wall clock. `advance` moves it; nothing ever sleeps."""

    def __init__(self, now: float = START):
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def fake_executor(exit_code=0, stdout="ok", stderr="", clock=None, duration=0.0):
    """An executor that records its calls and optionally consumes clock time."""
    calls = []

    def _run(action):
        calls.append(action)
        if clock is not None and duration:
            clock.advance(duration)
        return ExecutorResult(
            exit_code=exit_code, stdout=stdout, stderr=stderr, duration_ms=int(duration * 1000)
        )

    _run.calls = calls
    return _run


def ollama_declared(version="0.32.13"):
    return {"runtimes": {"ollama": {"state": "present", "version": version, "models": []}}}


def install_action(target_version="0.32.13") -> Action:
    return Action(
        kind="install_runtime",
        runtime="ollama",
        target_version=target_version,
        reason="declared present but not installed",
    )


# --- Policy: the escalation curve -------------------------------------------


def test_delay_escalates_by_four_and_caps_at_one_hour():
    assert delay_for(1) == 60
    assert delay_for(2) == 240
    assert delay_for(3) == 960
    assert delay_for(4) == MAX_DELAY_SECONDS == 3600
    # Capped, never terminal: a fingerprint stuck at the ceiling keeps being
    # retried hourly rather than being abandoned.
    assert delay_for(5) == 3600
    assert delay_for(50) == 3600


def test_fingerprint_distinguishes_target_version_and_model():
    assert fingerprint(install_action("0.32.13")) != fingerprint(install_action("0.33.0"))
    pull_a = Action(
        kind="pull_model", runtime="ollama", target_version=None, reason="", model_name="a:1"
    )
    pull_b = Action(
        kind="pull_model", runtime="ollama", target_version=None, reason="", model_name="b:1"
    )
    assert fingerprint(pull_a) != fingerprint(pull_b)


# --- Requirement 1: a failure is remembered and skips the next cycle --------


def test_first_failure_records_the_fingerprint_and_skips_the_next_cycle():
    clock = FakeClock()
    config = make_config()
    state = BackoffState(str("/unused"))
    install = fake_executor(exit_code=1, stdout="", stderr="boom", clock=clock, duration=5)

    first = converge(
        config,
        ollama_declared(),
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )
    assert first.status == "failed"
    assert len(install.calls) == 1
    # Failure observed at START + 5 (the executor consumed clock time), so
    # the next attempt is due 60s after the failure, not after the run began.
    assert state.entries[fingerprint(install_action())].next_retry_at == START + 5 + 60

    clock.advance(30)
    second = converge(
        config,
        ollama_declared(),
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )

    assert second.status == "cooling_down"
    assert len(install.calls) == 1, "a cooling-down action must not be executed"
    assert len(second.backed_off) == 1
    assert second.backed_off[0].consecutive_failures == 1
    assert second.backed_off[0].next_retry_at == START + 65
    assert second.backed_off[0].action.kind == "install_runtime"


# --- Requirement 2: the action runs again once the cooldown elapses ---------


def test_the_action_runs_again_after_the_cooldown_elapses():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    install = fake_executor(exit_code=1, stdout="", stderr="boom")

    def run_cycle():
        return converge(
            config,
            ollama_declared(),
            {},
            {"ollama": {"install_runtime": install}},
            dry_run=False,
            remote_converge=True,
            backoff=state,
            clock=clock,
        )

    run_cycle()
    assert len(install.calls) == 1

    clock.advance(59)
    assert run_cycle().status == "cooling_down"
    assert len(install.calls) == 1

    # Past the deadline (exclusive: the cycle landing exactly on it still
    # waits — see `BackoffState.cooling_down`).
    clock.advance(2)
    assert run_cycle().status == "failed"
    assert len(install.calls) == 2


# --- Requirement 3: consecutive failures escalate and cap -------------------


def test_consecutive_failures_escalate_60_240_960_then_cap_at_3600():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    key = fingerprint(install_action())

    observed_delays = []
    for _ in range(5):
        result = converge(
            config,
            ollama_declared(),
            {},
            {"ollama": {"install_runtime": install}},
            dry_run=False,
            remote_converge=True,
            backoff=state,
            clock=clock,
        )
        assert result.status == "failed"
        entry = state.entries[key]
        observed_delays.append(entry.next_retry_at - clock())
        # Jump just past the deadline so the next cycle actually attempts it.
        clock.advance(entry.next_retry_at - clock() + 1)

    assert observed_delays == [60, 240, 960, 3600, 3600]
    assert state.entries[key].consecutive_failures == 5
    assert len(install.calls) == 5


# --- Requirement 4: success clears the entry -------------------------------


def test_success_clears_the_entry_and_the_next_failure_starts_over_at_60s():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    key = fingerprint(install_action())

    failing = fake_executor(exit_code=1, stdout="", stderr="boom")
    converge(
        config,
        ollama_declared(),
        {},
        {"ollama": {"install_runtime": failing}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )
    assert state.entries[key].consecutive_failures == 1

    clock.advance(61)
    succeeding = fake_executor(exit_code=0)
    result = converge(
        config,
        ollama_declared(),
        {},
        {"ollama": {"install_runtime": succeeding}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )
    assert result.status == "succeeded"
    assert key not in state.entries

    # A later failure of the same fingerprint escalates from scratch.
    clock.advance(1)
    converge(
        config,
        ollama_declared(),
        {},
        {"ollama": {"install_runtime": failing}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )
    assert state.entries[key].consecutive_failures == 1
    assert state.entries[key].next_retry_at == clock() + 60


# --- Requirement 5: a changed declaration is a fresh start -----------------


def test_a_changed_target_version_is_a_new_fingerprint_and_runs_immediately():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    install = fake_executor(exit_code=1, stdout="", stderr="boom")

    converge(
        config,
        ollama_declared("0.32.13"),
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )
    old_key = fingerprint(install_action("0.32.13"))
    assert old_key in state.entries

    # The operator edited the role: a different declared version. Same host,
    # same cycle timing, but a different action — so it runs at once.
    clock.advance(30)
    result = converge(
        config,
        ollama_declared("0.33.0"),
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
        backoff=state,
        clock=clock,
    )

    assert result.status == "failed"
    assert len(install.calls) == 2
    assert old_key not in state.entries, "the stale fingerprint should be pruned"
    assert fingerprint(install_action("0.33.0")) in state.entries


# --- Requirement 6: only executor failures create entries ------------------


def test_a_disk_blocked_pull_never_creates_a_backoff_entry():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    desired = {
        "runtimes": {
            "ollama": {
                "state": "present",
                "models": [{"name": "qwen3:32b", "state": "present", "size_bytes": 999}],
            }
        }
    }
    actual = {"ollama": {"version": "0.32.13", "models": []}}
    pull = MagicMock(side_effect=AssertionError("a blocked pull must never be executed"))

    with patch(
        "zllama_agent.models.check_disk",
        return_value=DiskVerdict(ok=False, free_bytes=10, shortfall_bytes=989, reason="no room"),
    ):
        result = converge(
            config,
            desired,
            actual,
            {"ollama": {"pull_model": pull}},
            dry_run=False,
            remote_converge=True,
            backoff=state,
            clock=clock,
        )

    assert result.status == "blocked"
    assert state.entries == {}, "a disk precondition is planning-only and self-heals"


def test_vetoed_dry_run_and_no_changes_never_create_backoff_entries(tmp_path):
    clock = FakeClock()
    state_path = tmp_path / "backoff.json"
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    executors = {"ollama": {"install_runtime": install}}

    cases = [
        # (config, remote_converge, dry_run, expected status)
        (make_config(converge_flag=False), True, False, "vetoed"),
        (make_config(), False, False, "vetoed_remote"),
        (make_config(), None, False, "vetoed_remote"),
        (make_config(), True, True, "dry_run"),
    ]
    for config, remote, dry_run, expected in cases:
        state = BackoffState(str(state_path))
        result = converge(
            config,
            ollama_declared(),
            {},
            executors,
            dry_run=dry_run,
            remote_converge=remote,
            backoff=state,
            clock=clock,
        )
        assert result.status == expected
        assert state.entries == {}
        assert not state_path.exists(), "a run that executed nothing must write no state"

    assert install.calls == []


# --- Requirement 7: one backed-off action does not shield the others -------


def test_a_backed_off_action_does_not_prevent_another_action_from_running():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "version": "0.32.13", "models": []},
            "vllm": {"state": "absent", "models": []},
        }
    }
    actual = {"vllm": {"version": "1.0"}}
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    remove = fake_executor(exit_code=0)
    executors = {
        "ollama": {"install_runtime": install},
        "vllm": {"remove_runtime": remove},
    }

    # Cycle 1: the ollama install fails first and stops the run, so the vllm
    # removal is never reached.
    first = converge(
        config, desired, actual, executors, dry_run=False, remote_converge=True,
        backoff=state, clock=clock,
    )
    assert first.status == "failed"
    assert len(install.calls) == 1
    assert remove.calls == []

    # Cycle 2: the install is cooling down and is skipped — and the removal
    # behind it runs anyway rather than being shielded by it.
    clock.advance(30)
    second = converge(
        config, desired, actual, executors, dry_run=False, remote_converge=True,
        backoff=state, clock=clock,
    )

    assert len(install.calls) == 1
    assert len(remove.calls) == 1
    assert second.status == "succeeded"
    assert len(second.backed_off) == 1
    assert second.backed_off[0].action.runtime == "ollama"
    assert len(second.outcomes) == 1
    assert second.outcomes[0].action.runtime == "vllm"


# --- Requirement 8: run status ---------------------------------------------


def test_all_skipped_reports_cooling_down_and_mixed_ran_and_failed_reports_failed():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "version": "0.32.13", "models": []},
            "vllm": {"state": "absent", "models": []},
        }
    }
    actual = {"vllm": {"version": "1.0"}}
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    remove = fake_executor(exit_code=1, stdout="", stderr="nope")
    executors = {
        "ollama": {"install_runtime": install},
        "vllm": {"remove_runtime": remove},
    }

    # Cycle 1: install fails.
    assert converge(
        config, desired, actual, executors, dry_run=False, remote_converge=True,
        backoff=state, clock=clock,
    ).status == "failed"

    # Cycle 2: install is cooling down, removal runs and fails -> "failed",
    # because something did run and did fail.
    clock.advance(30)
    mixed = converge(
        config, desired, actual, executors, dry_run=False, remote_converge=True,
        backoff=state, clock=clock,
    )
    assert mixed.status == "failed"
    assert len(mixed.backed_off) == 1
    assert len(mixed.outcomes) == 1

    # Cycle 3: both are now cooling down and nothing ran at all.
    clock.advance(30)
    all_skipped = converge(
        config, desired, actual, executors, dry_run=False, remote_converge=True,
        backoff=state, clock=clock,
    )
    assert all_skipped.status == "cooling_down"
    assert len(all_skipped.backed_off) == 2
    assert all_skipped.outcomes == []
    assert all_skipped.error is not None and "waiting out" in all_skipped.error
    assert len(install.calls) == 1
    assert len(remove.calls) == 1


# --- Requirement 9: the state survives a restart ---------------------------


def test_state_survives_a_restart(tmp_path, monkeypatch):
    """Cycle one writes the file; a *new* BackoffState reads it back.

    This is the whole reason the state is on disk and timestamped with
    `time.time()`: systemd restarts the agent on failure, and an in-memory
    memory (or a `time.monotonic()` deadline) would silently forget the
    failure across exactly the restart this feature has to survive.
    """
    state_path = tmp_path / "backoff.json"
    monkeypatch.setattr(converge_module, "BACKOFF_STATE_PATH", str(state_path))

    clock = FakeClock()
    config = make_config()
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    executors = {"ollama": {"install_runtime": install}}

    # No `backoff=` argument: converge loads it from BACKOFF_STATE_PATH, the
    # way the real agent does on every cycle.
    first = converge(
        config, ollama_declared(), {}, executors, dry_run=False, remote_converge=True,
        clock=clock,
    )
    assert first.status == "failed"
    assert state_path.exists()

    # --- agent process dies here; systemd restarts it -----------------------
    clock.advance(30)
    second = converge(
        config, ollama_declared(), {}, executors, dry_run=False, remote_converge=True,
        clock=clock,
    )

    assert second.status == "cooling_down"
    assert len(install.calls) == 1
    assert second.backed_off[0].consecutive_failures == 1

    reloaded = BackoffState.load(str(state_path))
    assert reloaded.entries[fingerprint(install_action())].consecutive_failures == 1


# --- Requirement 10: a corrupt state file never breaks a cycle -------------


def test_corrupt_state_file_starts_empty_with_a_warning(tmp_path, caplog):
    state_path = tmp_path / "backoff.json"
    state_path.write_text('{"version": 1, "entries": {"install', encoding="utf-8")

    with caplog.at_level("WARNING"):
        state = BackoffState.load(str(state_path))

    assert state.entries == {}
    assert any("backoff state" in record.message for record in caplog.records)


def test_a_corrupt_state_file_does_not_stop_convergence(tmp_path, monkeypatch):
    state_path = tmp_path / "backoff.json"
    state_path.write_text("not json at all", encoding="utf-8")
    monkeypatch.setattr(converge_module, "BACKOFF_STATE_PATH", str(state_path))

    clock = FakeClock()
    install = fake_executor(exit_code=0)
    result = converge(
        make_config(), ollama_declared(), {}, {"ollama": {"install_runtime": install}},
        dry_run=False, remote_converge=True, clock=clock,
    )

    assert result.status == "succeeded"
    assert len(install.calls) == 1


def test_a_state_document_from_an_unknown_schema_version_is_ignored(tmp_path, caplog):
    state_path = tmp_path / "backoff.json"
    state_path.write_text(json.dumps({"version": 99, "entries": {"x": {}}}), encoding="utf-8")

    with caplog.at_level("WARNING"):
        state = BackoffState.load(str(state_path))

    assert state.entries == {}


def test_an_unwritable_state_path_logs_rather_than_raising(tmp_path, caplog):
    # A directory where the file should be: every write attempt fails.
    blocked_path = tmp_path / "backoff.json"
    blocked_path.mkdir()

    state = BackoffState(str(blocked_path))
    state.record_failure(install_action(), START)

    with caplog.at_level("WARNING"):
        state.save()  # must not raise

    assert any("could not write backoff state" in r.message for r in caplog.records)


# --- Requirement 11: the write is atomic-ish -------------------------------


def test_state_is_written_to_a_temp_file_then_renamed_over_the_real_one(tmp_path, monkeypatch):
    """A crash mid-write must not be able to corrupt the state file.

    The write goes to `<path>.tmp` and is then `os.replace`d into place —
    atomic within a filesystem, so a reader sees either the whole old
    document or the whole new one, never a truncated one.
    """
    state_path = tmp_path / "backoff.json"
    state = BackoffState(str(state_path))
    state.record_failure(install_action(), START)

    renames = []
    real_replace = backoff_module.os.replace

    def spy_replace(src, dst):
        # The temp file exists and holds the complete document *before* the
        # rename; the destination does not exist yet.
        renames.append((str(src), str(dst)))
        assert json.loads(open(src, encoding="utf-8").read())["version"] == 1
        real_replace(src, dst)

    monkeypatch.setattr(backoff_module.os, "replace", spy_replace)
    state.save()

    assert len(renames) == 1
    src, dst = renames[0]
    assert src == str(state_path) + ".tmp"
    assert dst == str(state_path)
    assert not (tmp_path / "backoff.json.tmp").exists()
    assert json.loads(state_path.read_text(encoding="utf-8"))["entries"]


def test_a_clean_cycle_writes_nothing_at_all(tmp_path, monkeypatch):
    """No failures, no memory to update, no disk write every 30 seconds."""
    state_path = tmp_path / "backoff.json"
    monkeypatch.setattr(converge_module, "BACKOFF_STATE_PATH", str(state_path))

    result = converge(
        make_config(), ollama_declared(), {}, {"ollama": {"install_runtime": fake_executor()}},
        dry_run=False, remote_converge=True, clock=FakeClock(),
    )

    assert result.status == "succeeded"
    assert not state_path.exists()


# --- Reporting: what the check-in carries ----------------------------------


def test_a_backed_off_action_is_serialized_with_its_next_retry_and_no_exit_code():
    clock = FakeClock()
    config = make_config()
    state = BackoffState("/unused")
    state.entries[fingerprint(install_action())] = BackoffEntry(
        consecutive_failures=2, next_retry_at=START + 240
    )
    install = fake_executor(exit_code=0)

    result = converge(
        config, ollama_declared(), {}, {"ollama": {"install_runtime": install}},
        dry_run=False, remote_converge=True, backoff=state, clock=clock,
    )
    assert result.status == "cooling_down"

    report = _serialize_result(result)

    assert report["status"] == "cooling_down"
    assert len(report["outcomes"]) == 1
    entry = report["outcomes"][0]
    assert entry["outcome"] == "backed_off"
    assert entry["next_retry_at"] == START + 240
    assert entry["consecutive_failures"] == 2
    # It never ran, so it has no exit status. Reporting 0 would read as
    # "this succeeded", which is the opposite of the truth.
    assert "exit_code" not in entry
    assert entry["action"]["kind"] == "install_runtime"
    # The whole report stays JSON-serializable and free of credentials.
    assert config.token not in json.dumps(report)
