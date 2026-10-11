"""Tests for the convergence engine: planning, veto, dry-run, serialization.

Every action is executed through an injected fake — no test here runs a real
command. `converge()` must never import or call `subprocess` itself; that is
enforced separately as a done-criterion (`grep -c subprocess converge.py`).
"""

import fcntl
import json
from dataclasses import asdict

import pytest

import zllama_agent.converge as converge_module
from zllama_agent.config import AgentConfig
from zllama_agent.converge import ACTION_KINDS, ExecutorResult, converge, plan_actions


def make_config(converge_flag: bool = True, token: str = "super-secret-token") -> AgentConfig:
    return AgentConfig(
        server="https://zllama.example",
        node_name="node-a",
        token=token,
        interval_seconds=30,
        converge=converge_flag,
        log_level="info",
    )


def ollama_declared(state="present", version=None):
    return {"runtimes": {"ollama": {"state": state, "version": version, "models": []}}}


def fake_executor(exit_code=0, stdout="ok", stderr=""):
    calls = []

    def _run(action):
        calls.append(action)
        return ExecutorResult(exit_code=exit_code, stdout=stdout, stderr=stderr, duration_ms=1)

    _run.calls = calls
    return _run


def result_to_plain(result) -> dict:
    """Convert a ConvergenceResult to something json.dumps can handle."""
    return {
        "status": result.status,
        "actions": [asdict(a) for a in result.actions],
        "outcomes": [
            {"action": asdict(outcome.action), **asdict(outcome.result)}
            for outcome in result.outcomes
        ],
        "error": result.error,
    }


# --- Planning (pure, no execution) --------------------------------------


def test_no_action_when_declared_and_actual_versions_match():
    desired = ollama_declared(version="0.32.13")
    actual = {"ollama": {"version": "0.32.13"}}
    assert plan_actions(desired, actual) == []


def test_upgrade_when_declared_version_differs_from_actual():
    desired = ollama_declared(version="0.32.13")
    actual = {"ollama": {"version": "0.32.3"}}
    actions = plan_actions(desired, actual)
    assert len(actions) == 1
    assert actions[0].kind == "upgrade_runtime"
    assert actions[0].runtime == "ollama"
    assert actions[0].target_version == "0.32.13"


def test_install_when_declared_present_and_not_installed():
    desired = ollama_declared(version="0.32.13")
    actual = {}
    actions = plan_actions(desired, actual)
    assert len(actions) == 1
    assert actions[0].kind == "install_runtime"
    assert actions[0].runtime == "ollama"
    assert actions[0].target_version == "0.32.13"


def test_remove_when_declared_absent_and_installed():
    desired = ollama_declared(state="absent")
    actual = {"ollama": {"version": "0.32.13"}}
    actions = plan_actions(desired, actual)
    assert len(actions) == 1
    assert actions[0].kind == "remove_runtime"
    assert actions[0].runtime == "ollama"


def test_no_action_when_declared_absent_and_not_installed():
    desired = ollama_declared(state="absent")
    actual = {}
    assert plan_actions(desired, actual) == []


def test_no_action_when_present_with_no_version_declared():
    desired = ollama_declared(version=None)
    actual = {"ollama": {"version": "9.9.9"}}
    assert plan_actions(desired, actual) == []


def test_version_comparison_is_exact_string_not_semver():
    desired = ollama_declared(version="0.1.dev1+gabc")
    actual = {"ollama": {"version": "0.1.dev2+gdef"}}
    actions = plan_actions(desired, actual)
    assert len(actions) == 1
    assert actions[0].kind == "upgrade_runtime"
    assert actions[0].target_version == "0.1.dev1+gabc"


def test_action_kind_is_always_one_of_the_closed_set():
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "version": "0.32.13", "models": []},
            "vllm": {"state": "absent", "models": []},
        }
    }
    actual = {"ollama": {"version": "0.1.0"}, "vllm": {"version": "1.0"}}
    actions = plan_actions(desired, actual)

    assert actions
    assert ACTION_KINDS == frozenset(
        {
            "install_runtime",
            "upgrade_runtime",
            "remove_runtime",
            "pull_model",
            "remove_model",
        }
    )
    for action in actions:
        assert action.kind in ACTION_KINDS


def test_unknown_runtime_kind_raises_instead_of_being_skipped():
    desired = {"runtimes": {"lmstudio": {"state": "present", "models": []}}}
    with pytest.raises(ValueError):
        plan_actions(desired, actual={})


# --- Safety: veto, dry-run, serialization, execution --------------------


def test_converge_false_vetoes_and_calls_no_executor():
    config = make_config(converge_flag=False)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )

    assert result.status == "vetoed"
    assert len(result.actions) == 1
    assert install.calls == []


def test_dry_run_executes_nothing():
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=True,
        remote_converge=True,
    )

    assert result.status == "dry_run"
    assert len(result.actions) == 1
    assert install.calls == []


def test_dry_run_must_be_passed_explicitly():
    config = make_config()
    desired = ollama_declared()
    with pytest.raises(TypeError):
        converge(config, desired, {}, {})  # dry_run omitted


def test_unknown_runtime_raises_rather_than_being_silently_skipped():
    config = make_config()
    desired = {"runtimes": {"lmstudio": {"state": "present", "models": []}}}
    with pytest.raises(ValueError):
        converge(config, desired, {}, {}, dry_run=True, remote_converge=True)


def test_failing_executor_stops_the_run_and_skips_later_actions():
    config = make_config(converge_flag=True)
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "version": "0.32.13", "models": []},
            "vllm": {"state": "absent", "models": []},
        }
    }
    actual = {"vllm": {"version": "1.0"}}
    install = fake_executor(exit_code=1, stdout="", stderr="boom")
    remove = fake_executor(exit_code=0)
    executors = {"ollama": {"install_runtime": install}, "vllm": {"remove_runtime": remove}}

    result = converge(config, desired, actual, executors, dry_run=False, remote_converge=True)

    assert result.status == "failed"
    assert len(result.outcomes) == 1
    assert result.outcomes[0].result.exit_code == 1
    assert result.outcomes[0].result.stderr == "boom"
    assert remove.calls == []


def test_success_records_one_outcome_per_action():
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor(exit_code=0, stdout="installed")

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )

    assert result.status == "succeeded"
    assert len(result.outcomes) == 1
    assert result.outcomes[0].result.stdout == "installed"
    assert len(install.calls) == 1


def test_no_actions_short_circuits_with_no_executor_calls():
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    actual = {"ollama": {"version": "0.32.13"}}
    install = fake_executor()
    executors = {"ollama": {"install_runtime": install}}

    result = converge(config, desired, actual, executors, dry_run=False, remote_converge=True)

    assert result.status == "no_changes"
    assert result.actions == []
    assert install.calls == []


def test_token_never_appears_in_the_serialized_result():
    config = make_config(converge_flag=True, token="super-secret-token")
    desired = ollama_declared(version="0.32.13")
    install = fake_executor(exit_code=0, stdout="installed")

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )

    serialized = json.dumps(result_to_plain(result))
    assert config.token not in serialized


def test_busy_when_lock_already_held(tmp_path, monkeypatch):
    lock_path = tmp_path / "converge.lock"
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(lock_path))

    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()
    executors = {"ollama": {"install_runtime": install}}

    with open(lock_path, "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        result = converge(config, desired, {}, executors, dry_run=False, remote_converge=True)

    assert result.status == "busy"
    assert install.calls == []


def test_lock_is_released_after_a_successful_run(tmp_path, monkeypatch):
    lock_path = tmp_path / "converge.lock"
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(lock_path))

    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )
    assert result.status == "succeeded"

    # The lock must be free again for the next cycle.
    with open(lock_path, "w") as held:
        fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(held, fcntl.LOCK_UN)


def test_no_actions_never_touches_the_lock(tmp_path, monkeypatch):
    # A path that can't be created (parent dir missing) would raise if
    # `converge()` tried to lock it. When there is nothing to do, it must
    # not even attempt to.
    lock_path = tmp_path / "does-not-exist" / "converge.lock"
    monkeypatch.setattr(converge_module, "LOCK_PATH", str(lock_path))

    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    actual = {"ollama": {"version": "0.32.13"}}

    result = converge(config, desired, actual, {}, dry_run=False, remote_converge=True)

    assert result.status == "no_changes"


# --- Two-sided veto: local config AND zllama's last-known opinion --------
#
# `config.converge` (local, agent.yaml) and `remote_converge` (zllama's
# last-known opinion, threaded in by the caller from a check-in response)
# are independent vetoes. Either being anything other than `True` means
# plan-but-don't-apply. Local wins the label when both refuse.


def test_local_true_and_remote_true_applies_changes():
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor(exit_code=0, stdout="installed")

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )

    assert result.status == "succeeded"
    assert len(install.calls) == 1


def test_local_true_remote_false_vetoes_remotely_and_calls_no_executor():
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=False,
    )

    assert result.status == "vetoed_remote"
    assert len(result.actions) == 1
    assert install.calls == []


def test_local_false_remote_true_vetoes_locally_not_remotely():
    # The local veto's label ("vetoed", not "vetoed_remote") must win even
    # though the remote side would have allowed it — the local config is
    # the stronger, absolute guarantee.
    config = make_config(converge_flag=False)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=True,
    )

    assert result.status == "vetoed"
    assert install.calls == []


def test_local_false_and_remote_false_vetoes_locally():
    config = make_config(converge_flag=False)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=False,
    )

    assert result.status == "vetoed"
    assert install.calls == []


def test_missing_remote_converge_fails_closed_to_vetoed_remote():
    # `None` stands for "the server didn't say" (an absent key on a
    # response, or the host isn't even approved yet). A server that did not
    # say yes has not said yes — this must behave exactly like an explicit
    # `False`, not like an implicit `True`.
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")
    install = fake_executor()

    result = converge(
        config,
        desired,
        {},
        {"ollama": {"install_runtime": install}},
        dry_run=False,
        remote_converge=None,
    )

    assert result.status == "vetoed_remote"
    assert install.calls == []


def test_remote_converge_must_be_passed_explicitly():
    # Symmetric with dry_run: converge() must never default this to True
    # (which would silently reopen the fail-open hole this whole change
    # fixes) or to False/None (which would make every plain converge()
    # call in this file's other tests start failing). The caller decides,
    # every time.
    config = make_config()
    desired = ollama_declared()
    with pytest.raises(TypeError):
        converge(config, desired, {}, {}, dry_run=True)  # remote_converge omitted


def test_vetoed_remote_is_in_the_closed_action_kind_independent_status_set():
    # Not an Action kind (those stay {install_runtime, upgrade_runtime,
    # remove_runtime, pull_model, remove_model} regardless), but the new
    # status must actually be reachable, not just documented.
    config = make_config(converge_flag=True)
    desired = ollama_declared(version="0.32.13")

    result = converge(config, desired, {}, {}, dry_run=False, remote_converge=False)

    assert result.status == "vetoed_remote"
    assert ACTION_KINDS == frozenset(
        {
            "install_runtime",
            "upgrade_runtime",
            "remove_runtime",
            "pull_model",
            "remove_model",
        }
    )
