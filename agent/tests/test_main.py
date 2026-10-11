"""Tests for the agent's per-cycle orchestration.

`run_forever`'s `while True` loop itself is not exercised directly; `_run_cycle`
is the pure-ish unit it wraps once per interval, and is what's tested here.
"""

from unittest.mock import patch

import pytest

from zllama_agent.config import AgentConfig
from zllama_agent.converge import Action, ActionOutcome, ConvergenceResult, ExecutorResult
from zllama_agent.main import (
    EXECUTORS,
    _allow_apply,
    _disallow_apply,
    _is_dry_run,
    _run_cycle,
    main,
)

CONFIG = AgentConfig(
    server="https://zllama.example",
    node_name="node-a",
    token="super-secret-token",
    interval_seconds=30,
    converge=True,
    log_level="info",
)


def test_executors_are_wired_for_model_actions_not_just_runtime_actions():
    # A real cycle plans pull_model/remove_model via plan_model_actions
    # alongside plan_actions's runtime actions, and _execute looks both up
    # in the same per-runtime map. Missing either here means a declared
    # model raises "no executor registered" on every real run.
    for runtime in ("ollama", "vllm"):
        for kind in ("install_runtime", "upgrade_runtime", "remove_runtime"):
            assert kind in EXECUTORS[runtime]
        for kind in ("pull_model", "remove_model"):
            assert kind in EXECUTORS[runtime]


def test_is_dry_run_true_when_state_file_absent(tmp_path):
    missing = tmp_path / "converged-once"
    assert _is_dry_run(str(missing)) is True


def test_is_dry_run_false_when_state_file_present(tmp_path):
    marker = tmp_path / "converged-once"
    marker.write_text("")
    assert _is_dry_run(str(marker)) is False


def test_cycle_skips_convergence_when_check_in_reports_no_desired_state():
    with (
        patch("zllama_agent.main.check_in", return_value={"status": "pending"}) as mock_check_in,
        patch("zllama_agent.main.converge") as mock_converge,
    ):
        report = _run_cycle(CONFIG, None)

    mock_check_in.assert_called_once_with(CONFIG, convergence=None)
    mock_converge.assert_not_called()
    assert report is None


def test_cycle_converges_when_desired_state_present_and_returns_a_report():
    desired = {"runtimes": {"ollama": {"state": "present", "version": "0.32.13", "models": []}}}
    response = {"status": "approved", "converge": True, "desired": desired}
    action = Action(kind="install_runtime", runtime="ollama", target_version="0.32.13", reason="x")
    fake_result = ConvergenceResult(
        status="succeeded",
        actions=[action],
        outcomes=[ActionOutcome(action=action, result=ExecutorResult(0, "ok", "", 5))],
    )

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
        patch("zllama_agent.main._is_dry_run", return_value=False),
        patch("zllama_agent.main.converge", return_value=fake_result) as mock_converge,
    ):
        report = _run_cycle(CONFIG, None)

    assert mock_converge.call_args.kwargs["dry_run"] is False
    assert report["status"] == "succeeded"
    assert report["actions"][0]["kind"] == "install_runtime"
    assert CONFIG.token not in str(report)


def test_cycle_defaults_to_dry_run_when_no_state_file_exists():
    desired = {"runtimes": {"ollama": {"state": "present", "models": []}}}
    response = {"status": "approved", "converge": True, "desired": desired}
    fake_result = ConvergenceResult(status="dry_run", actions=[])

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
        patch("os.path.exists", return_value=False),
        patch("zllama_agent.main.converge", return_value=fake_result) as mock_converge,
    ):
        _run_cycle(CONFIG, None)

    assert mock_converge.call_args.kwargs["dry_run"] is True


def test_cycle_threads_the_servers_converge_opinion_through_to_converge():
    # The server's last-known opinion must reach converge() as the explicit
    # remote_converge argument — not be read by converge() itself, and not
    # be dropped on the floor by main.py.
    desired = {"runtimes": {"ollama": {"state": "present", "models": []}}}
    response = {"status": "approved", "converge": False, "desired": desired}
    fake_result = ConvergenceResult(status="vetoed_remote", actions=[])

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
        patch("zllama_agent.main._is_dry_run", return_value=False),
        patch("zllama_agent.main.converge", return_value=fake_result) as mock_converge,
    ):
        report = _run_cycle(CONFIG, None)

    assert mock_converge.call_args.kwargs["remote_converge"] is False
    assert report["status"] == "vetoed_remote"


def test_cycle_passes_remote_converge_true_through_unchanged():
    desired = {"runtimes": {"ollama": {"state": "present", "models": []}}}
    response = {"status": "approved", "converge": True, "desired": desired}
    fake_result = ConvergenceResult(status="succeeded", actions=[])

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
        patch("zllama_agent.main._is_dry_run", return_value=False),
        patch("zllama_agent.main.converge", return_value=fake_result) as mock_converge,
    ):
        _run_cycle(CONFIG, None)

    assert mock_converge.call_args.kwargs["remote_converge"] is True


def test_cycle_passes_none_through_when_the_response_omits_converge_entirely():
    # A response missing the `converge` key altogether (e.g. a server that
    # simply didn't set it) must reach converge() as None, not be defaulted
    # to True by main.py — converge() itself is what fails closed on that,
    # but only if main.py hands it the real, un-coerced value.
    desired = {"runtimes": {"ollama": {"state": "present", "models": []}}}
    response = {"status": "approved", "desired": desired}  # no "converge" key
    fake_result = ConvergenceResult(status="vetoed_remote", actions=[])

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
        patch("zllama_agent.main._is_dry_run", return_value=False),
        patch("zllama_agent.main.converge", return_value=fake_result) as mock_converge,
    ):
        report = _run_cycle(CONFIG, None)

    assert mock_converge.call_args.kwargs["remote_converge"] is None
    assert report["status"] == "vetoed_remote"


def test_cycle_survives_a_failing_check_in_without_raising():
    with patch("zllama_agent.main.check_in", side_effect=OSError("network unreachable")):
        report = _run_cycle(CONFIG, None)
    assert report is None


def test_cycle_survives_convergence_raising_without_raising():
    desired = {"runtimes": {"lmstudio": {"state": "present", "models": []}}}
    response = {"status": "approved", "converge": True, "desired": desired}

    with (
        patch("zllama_agent.main.check_in", return_value=response),
        patch("zllama_agent.main.collect_runtimes", return_value=[]),
    ):
        # No mock on converge: the real converge() raises ValueError for an
        # unrecognized runtime kind. _run_cycle must swallow it, not crash.
        report = _run_cycle(CONFIG, None)

    assert report is None


def test_cycle_forwards_the_prior_cycle_s_report_to_check_in():
    prior_report = {"status": "succeeded", "actions": [], "outcomes": [], "error": None}
    with patch("zllama_agent.main.check_in", return_value={"status": "pending"}) as mock_check_in:
        _run_cycle(CONFIG, prior_report)

    mock_check_in.assert_called_once_with(CONFIG, convergence=prior_report)


# --- --allow-apply / --disallow-apply --------------------------------------
#
# Opting a host into applying changes is a deliberate, local operator
# action, not something the loop decides on its own. These tests never
# touch the real CONVERGED_ONCE_PATH; every case passes its own
# `tmp_path`-derived state_path.


def test_allow_apply_creates_state_file_including_missing_parent_dirs(tmp_path):
    nested = tmp_path / "var" / "lib" / "zllama-agent" / "converged-once"
    assert not nested.parent.exists()

    _allow_apply(str(nested))

    assert nested.exists()
    assert nested.is_file()


def test_allow_apply_is_idempotent_when_called_twice(tmp_path):
    marker = tmp_path / "converged-once"

    _allow_apply(str(marker))
    _allow_apply(str(marker))

    assert marker.exists()


def test_disallow_apply_removes_an_existing_state_file(tmp_path):
    marker = tmp_path / "converged-once"
    marker.write_text("")

    _disallow_apply(str(marker))

    assert not marker.exists()


def test_disallow_apply_is_idempotent_when_the_file_is_already_absent(tmp_path):
    missing = tmp_path / "converged-once"
    assert not missing.exists()

    _disallow_apply(str(missing))  # must not raise

    assert not missing.exists()


def test_allow_apply_then_disallow_apply_round_trips_back_to_dry_run(tmp_path):
    marker = tmp_path / "nested" / "converged-once"

    _allow_apply(str(marker))
    assert _is_dry_run(str(marker)) is False

    _disallow_apply(str(marker))
    assert _is_dry_run(str(marker)) is True


def test_main_allow_apply_flag_calls_allow_apply_and_exits_without_running_forever():
    with (
        patch("sys.argv", ["zllama-agent", "--allow-apply"]),
        patch("zllama_agent.main._allow_apply") as mock_allow_apply,
        patch("zllama_agent.main._disallow_apply") as mock_disallow_apply,
        patch("zllama_agent.main.run_forever") as mock_run_forever,
        patch("zllama_agent.main.load_config") as mock_load_config,
    ):
        main()

    mock_allow_apply.assert_called_once_with()
    mock_disallow_apply.assert_not_called()
    mock_run_forever.assert_not_called()
    mock_load_config.assert_not_called()


def test_main_disallow_apply_flag_calls_disallow_apply_and_exits_without_running_forever():
    with (
        patch("sys.argv", ["zllama-agent", "--disallow-apply"]),
        patch("zllama_agent.main._allow_apply") as mock_allow_apply,
        patch("zllama_agent.main._disallow_apply") as mock_disallow_apply,
        patch("zllama_agent.main.run_forever") as mock_run_forever,
        patch("zllama_agent.main.load_config") as mock_load_config,
    ):
        main()

    mock_disallow_apply.assert_called_once_with()
    mock_allow_apply.assert_not_called()
    mock_run_forever.assert_not_called()
    mock_load_config.assert_not_called()


def test_main_with_no_apply_flag_runs_forever_as_before():
    with (
        patch("sys.argv", ["zllama-agent", "--config", "/etc/zllama/agent.yaml"]),
        patch("zllama_agent.main._allow_apply") as mock_allow_apply,
        patch("zllama_agent.main._disallow_apply") as mock_disallow_apply,
        patch("zllama_agent.main.run_forever") as mock_run_forever,
    ):
        main()

    mock_run_forever.assert_called_once_with("/etc/zllama/agent.yaml")
    mock_allow_apply.assert_not_called()
    mock_disallow_apply.assert_not_called()


def test_allow_apply_and_disallow_apply_are_mutually_exclusive():
    with patch("sys.argv", ["zllama-agent", "--allow-apply", "--disallow-apply"]):
        with pytest.raises(SystemExit):
            main()


def test_allow_apply_flag_takes_no_value_and_requires_no_token(tmp_path):
    """`--allow-apply` is a bare flag: passing it a value is a parse error,
    proving it cannot be mistaken for something that accepts a token."""
    with patch("sys.argv", ["zllama-agent", "--allow-apply=some-token"]):
        with pytest.raises(SystemExit):
            main()
