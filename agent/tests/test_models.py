"""Tests for model convergence: planning, disk preconditions, and the
Ollama/vLLM model executors.

Every subprocess call and every HTTP call is mocked — no test here pulls a
real model, deletes a real directory, or talks to a real Ollama daemon.
"""

import json
import urllib.error
from unittest.mock import MagicMock, patch

from zllama_agent.converge import ACTION_KINDS, MODEL_ACTION_KINDS, Action
from zllama_agent.models import (
    OLLAMA_MODEL_EXECUTORS,
    VLLM_MODEL_CACHE_ROOT,
    VLLM_MODEL_EXECUTORS,
    DiskVerdict,
    _parse_pull_progress,
    check_disk,
    plan_model_actions,
)


def make_action(kind, runtime, **kwargs):
    defaults = {"target_version": None, "reason": "test"}
    defaults.update(kwargs)
    return Action(kind=kind, runtime=runtime, **defaults)


def mock_run(returncode=0, stdout="", stderr=""):
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


def _http_response(body: str = "") -> MagicMock:
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = body.encode("utf-8")
    return response


# --- Planning ----------------------------------------------------------------


def test_pull_planned_when_declared_present_and_not_installed():
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "models": [{"name": "qwen3:32b", "state": "present"}]}
        }
    }
    actual = {"ollama": {"version": "0.32.13", "models": []}}

    actions = plan_model_actions(desired, actual)

    assert len(actions) == 1
    assert actions[0].kind == "pull_model"
    assert actions[0].runtime == "ollama"
    assert actions[0].model_name == "qwen3:32b"


def test_no_action_when_declared_present_and_already_installed():
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "models": [{"name": "qwen3:32b", "state": "present"}]}
        }
    }
    actual = {"ollama": {"version": "0.32.13", "models": [{"name": "qwen3:32b", "sizeBytes": 123}]}}

    assert plan_model_actions(desired, actual) == []


def test_remove_planned_when_declared_absent_and_installed():
    desired = {
        "runtimes": {
            "ollama": {"state": "present", "models": [{"name": "qwen3:32b", "state": "absent"}]}
        }
    }
    actual = {"ollama": {"version": "0.32.13", "models": [{"name": "qwen3:32b", "sizeBytes": 123}]}}

    actions = plan_model_actions(desired, actual)

    assert len(actions) == 1
    assert actions[0].kind == "remove_model"
    assert actions[0].model_name == "qwen3:32b"


def test_present_but_undeclared_model_generates_no_action():
    # The never-delete-implicitly rule at the planning layer: a model that
    # is installed but never named in the declaration must not appear as
    # any action, in either direction.
    desired = {"runtimes": {"ollama": {"state": "present", "models": []}}}
    actual = {
        "ollama": {
            "version": "0.32.13",
            "models": [{"name": "stray-model:latest", "sizeBytes": 999}],
        }
    }

    assert plan_model_actions(desired, actual) == []


def test_action_kind_always_in_the_closed_set_including_model_kinds():
    assert ACTION_KINDS == frozenset(
        {
            "install_runtime",
            "upgrade_runtime",
            "remove_runtime",
            "pull_model",
            "remove_model",
        }
    )
    assert MODEL_ACTION_KINDS == frozenset({"pull_model", "remove_model"})
    assert MODEL_ACTION_KINDS <= ACTION_KINDS

    desired = {
        "runtimes": {
            "ollama": {
                "state": "present",
                "models": [
                    {"name": "qwen3:32b", "state": "present"},
                    {"name": "old-model:latest", "state": "absent"},
                ],
            }
        }
    }
    actual = {
        "ollama": {"version": "0.32.13", "models": [{"name": "old-model:latest", "sizeBytes": 1}]}
    }
    actions = plan_model_actions(desired, actual)

    assert actions
    for action in actions:
        assert action.kind in ACTION_KINDS


# --- Disk preconditions ------------------------------------------------------


def test_check_disk_ok_when_required_bytes_below_free_space(tmp_path):
    verdict = check_disk(1, str(tmp_path))
    assert verdict.ok is True
    assert verdict.shortfall_bytes == 0


def test_check_disk_not_ok_with_exact_shortfall_when_required_exceeds_free(tmp_path):
    free_bytes = check_disk(1, str(tmp_path)).free_bytes
    required = free_bytes + 12345

    verdict = check_disk(required, str(tmp_path))

    assert verdict.ok is False
    assert verdict.shortfall_bytes == 12345


def test_check_disk_treats_unknown_size_as_not_fitting(tmp_path):
    verdict = check_disk(None, str(tmp_path))
    assert verdict.ok is False
    assert verdict.reason is not None


# --- converge() integration: blocked pulls ----------------------------------


def _make_config(converge_flag=True):
    from zllama_agent.config import AgentConfig

    return AgentConfig(
        server="https://zllama.example",
        node_name="node-a",
        token="super-secret-token",
        interval_seconds=30,
        converge=converge_flag,
        log_level="info",
    )


def test_converge_blocks_a_pull_that_fails_disk_check_and_calls_no_executor():
    import zllama_agent.converge as converge_module

    config = _make_config()
    desired = {
        "runtimes": {
            "ollama": {
                "state": "present",
                "models": [{"name": "qwen3:32b", "state": "present", "size_bytes": 999}],
            }
        }
    }
    # `ollama` itself is already installed (no version declared to compare),
    # so `plan_actions` plans nothing for the runtime — the only planned
    # action here is the model pull, isolating the disk-block behavior.
    actual = {"ollama": {"version": "0.32.13", "models": []}}
    pull = MagicMock(side_effect=AssertionError("executor must never be called for a blocked pull"))

    with patch(
        "zllama_agent.models.check_disk",
        return_value=DiskVerdict(
            ok=False, free_bytes=10, shortfall_bytes=989, reason="not enough room"
        ),
    ):
        result = converge_module.converge(
            config,
            desired,
            actual,
            {"ollama": {"pull_model": pull}},
            dry_run=False,
            remote_converge=True,
        )

    assert result.status == "blocked"
    assert pull.call_count == 0
    assert len(result.blocked) == 1
    assert result.blocked[0].shortfall_bytes == 989
    assert result.blocked[0].action.model_name == "qwen3:32b"


def test_blocked_pull_does_not_prevent_an_unrelated_runtime_action():
    import zllama_agent.converge as converge_module

    config = _make_config()
    desired = {
        "runtimes": {
            "ollama": {
                "state": "present",
                "models": [{"name": "qwen3:32b", "state": "present", "size_bytes": 999}],
            },
            "vllm": {"state": "present", "version": "0.9.0", "models": []},
        }
    }
    # `ollama` is already installed, so the only ollama action is the model
    # pull; `vllm` is not installed at all, so it plans an unrelated
    # `install_runtime` action that must still go through.
    actual = {"ollama": {"version": "0.32.13", "models": []}}
    pull = MagicMock(side_effect=AssertionError("executor must never be called for a blocked pull"))
    install = MagicMock(
        return_value=converge_module.ExecutorResult(
            exit_code=0, stdout="ok", stderr="", duration_ms=1
        )
    )

    with patch(
        "zllama_agent.models.check_disk",
        return_value=DiskVerdict(
            ok=False, free_bytes=10, shortfall_bytes=989, reason="not enough room"
        ),
    ):
        result = converge_module.converge(
            config,
            desired,
            actual,
            {"ollama": {"pull_model": pull}, "vllm": {"install_runtime": install}},
            dry_run=False,
            remote_converge=True,
        )

    assert result.status == "blocked"
    assert pull.call_count == 0
    assert install.call_count == 1
    assert any(o.action.kind == "install_runtime" for o in result.outcomes)


def test_converge_carries_a_pull_executors_progress_onto_the_convergence_result():
    import zllama_agent.converge as converge_module

    config = _make_config()
    desired = {
        "runtimes": {
            "ollama": {
                "state": "present",
                "models": [{"name": "qwen3:32b", "state": "present", "size_bytes": 10}],
            }
        }
    }
    actual = {"ollama": {"version": "0.32.13", "models": []}}
    pull = MagicMock(
        return_value=converge_module.ExecutorResult(
            exit_code=0,
            stdout="",
            stderr="",
            duration_ms=5,
            current_action="success",
            progress_pct=100.0,
        )
    )

    with patch(
        "zllama_agent.models.check_disk",
        return_value=DiskVerdict(ok=True, free_bytes=1_000_000, shortfall_bytes=0),
    ):
        result = converge_module.converge(
            config,
            desired,
            actual,
            {"ollama": {"pull_model": pull}},
            dry_run=False,
            remote_converge=True,
        )

    assert result.status == "succeeded"
    assert result.current_action == "success"
    assert result.progress_pct == 100.0


def test_blocked_pull_still_appears_in_the_serialized_report_with_its_shortfall():
    # Regression guard for the wiring gap this closes: a blocked action is
    # `continue`d past in `_execute` and never gets an `ActionOutcome`, so
    # `main._serialize_result` must still surface it (by matching against
    # `result.blocked`, not by list position) or the operator never learns
    # why a declared model never showed up.
    import zllama_agent.converge as converge_module
    from zllama_agent.main import _serialize_result

    action = make_action("pull_model", "ollama", model_name="qwen3:32b")
    result = converge_module.ConvergenceResult(
        status="blocked",
        actions=[action],
        outcomes=[],
        blocked=[
            converge_module.BlockedAction(
                action=action, shortfall_bytes=989, reason="not enough room"
            )
        ],
        error="1 model pull(s) blocked by insufficient disk space",
    )

    serialized = _serialize_result(result)

    assert len(serialized["outcomes"]) == 1
    outcome = serialized["outcomes"][0]
    assert outcome["blocked"] is True
    assert outcome["shortfall_bytes"] == 989
    assert outcome["action"]["model_name"] == "qwen3:32b"


# --- NDJSON pull progress parsing -------------------------------------------


def ndjson(*lines):
    return "\n".join(json.dumps(line) for line in lines)


def test_pull_progress_is_monotonic_as_completed_grows():
    early = _parse_pull_progress(
        ndjson({"status": "downloading", "total": 1000, "completed": 100})
    )
    later = _parse_pull_progress(
        ndjson(
            {"status": "downloading", "total": 1000, "completed": 100},
            {"status": "downloading", "total": 1000, "completed": 900},
        )
    )
    assert early.progress_pct == 10.0
    assert later.progress_pct == 90.0
    assert later.progress_pct > early.progress_pct


def test_pull_progress_skips_a_malformed_line_without_aborting():
    raw = "\n".join(
        [
            json.dumps({"status": "downloading", "total": 1000, "completed": 500}),
            "{ not valid json",
            json.dumps({"status": "success"}),
        ]
    )
    progress = _parse_pull_progress(raw)

    assert progress.error is None
    assert progress.current_action == "success"
    assert progress.progress_pct == 50.0


def test_pull_progress_fails_on_a_line_carrying_error():
    raw = ndjson(
        {"status": "downloading", "total": 1000, "completed": 100},
        {"error": "pull model manifest: file does not exist"},
    )
    progress = _parse_pull_progress(raw)

    assert progress.error == "pull model manifest: file does not exist"


def test_pull_progress_is_clamped_to_100_when_completed_exceeds_total():
    progress = _parse_pull_progress(
        ndjson({"status": "downloading", "total": 1000, "completed": 1400})
    )
    assert progress.progress_pct == 100.0


def test_pull_progress_is_clamped_to_0_and_never_negative():
    progress = _parse_pull_progress(
        ndjson({"status": "downloading", "total": 1000, "completed": -50})
    )
    assert progress.progress_pct == 0.0


# --- Ollama model executors --------------------------------------------------


def test_ollama_pull_reports_current_action_and_progress_pct_on_success():
    action = make_action("pull_model", "ollama", model_name="qwen3:32b")
    raw = ndjson(
        {"status": "downloading", "total": 1000, "completed": 500},
        {"status": "success"},
    )

    with patch("urllib.request.urlopen", return_value=_http_response(raw)):
        result = OLLAMA_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code == 0
    assert result.current_action == "success"
    # The final "success" line carries no total/completed, so the last
    # known percentage is whatever the last size-bearing line reported.
    assert result.progress_pct == 50.0


def test_ollama_pull_fails_when_the_stream_reports_an_error_line():
    action = make_action("pull_model", "ollama", model_name="qwen3:32b")
    raw = ndjson(
        {"status": "downloading", "total": 1000, "completed": 100},
        {"error": "manifest unknown"},
    )

    with patch("urllib.request.urlopen", return_value=_http_response(raw)):
        result = OLLAMA_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code != 0
    assert result.stderr == "manifest unknown"
    assert result.progress_pct == 10.0


def test_ollama_pull_calls_the_pull_endpoint_with_the_tag_as_data():
    malicious_tag = "qwen3:32b; rm -rf /"
    action = make_action("pull_model", "ollama", model_name=malicious_tag)

    with patch("urllib.request.urlopen", return_value=_http_response("{}")) as mock_urlopen:
        result = OLLAMA_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code == 0
    request = mock_urlopen.call_args[0][0]
    assert request.full_url.endswith("/api/pull")
    body = json.loads(request.data.decode("utf-8"))
    assert body["name"] == malicious_tag
    # The tag reached the daemon only as a JSON field of an HTTP request —
    # no shell was ever invoked to interpret it.
    assert mock_urlopen.call_args.kwargs.get("timeout") is not None


def test_ollama_remove_calls_the_delete_endpoint_for_exactly_the_named_tag():
    action = make_action("remove_model", "ollama", model_name="qwen3:32b")

    with patch("urllib.request.urlopen", return_value=_http_response("{}")) as mock_urlopen:
        result = OLLAMA_MODEL_EXECUTORS["remove_model"](action)

    assert result.exit_code == 0
    request = mock_urlopen.call_args[0][0]
    assert request.full_url.endswith("/api/delete")
    assert request.get_method() == "DELETE"
    body = json.loads(request.data.decode("utf-8"))
    assert body == {"name": "qwen3:32b"}


def test_ollama_pull_non_zero_http_status_is_returned_not_raised():
    action = make_action("pull_model", "ollama", model_name="qwen3:32b")
    error = urllib.error.HTTPError("http://localhost:11434/api/pull", 500, "boom", {}, None)
    error.read = lambda: b"server error"

    with patch("urllib.request.urlopen", side_effect=error):
        result = OLLAMA_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code == 500
    assert "server error" in result.stderr


def test_ollama_calls_have_an_explicit_timeout():
    action = make_action("remove_model", "ollama", model_name="qwen3:32b")
    with patch("urllib.request.urlopen", return_value=_http_response("{}")) as mock_urlopen:
        OLLAMA_MODEL_EXECUTORS["remove_model"](action)

    assert mock_urlopen.call_args.kwargs["timeout"] is not None
    assert mock_urlopen.call_args.kwargs["timeout"] > 0


# --- vLLM model executors -----------------------------------------------------


def test_vllm_pull_downloads_the_repo_into_the_managed_cache_path_via_argv():
    malicious_repo = "org/model; rm -rf /"
    action = make_action("pull_model", "vllm", model_repo=malicious_repo)

    with patch("zllama_agent.models.subprocess.run", return_value=mock_run(0, "ok")) as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code == 0
    call = run.call_args
    assert isinstance(call.args[0], list)
    assert call.kwargs.get("shell") is not True
    assert malicious_repo in call.args[0]
    matching = [arg for arg in call.args[0] if arg == malicious_repo]
    assert len(matching) == 1
    assert any(VLLM_MODEL_CACHE_ROOT in arg for arg in call.args[0])


def test_vllm_pull_has_an_explicit_timeout():
    action = make_action("pull_model", "vllm", model_repo="org/model")
    with patch("zllama_agent.models.subprocess.run", return_value=mock_run(0)) as run:
        VLLM_MODEL_EXECUTORS["pull_model"](action)

    assert run.call_args.kwargs.get("timeout") is not None
    assert run.call_args.kwargs["timeout"] > 0


def test_vllm_pull_rejects_a_repo_id_that_would_escape_the_cache_root_via_traversal():
    # The mirror of the remove-path traversal test, and just as load-bearing:
    # the agent runs as root under zllama-agent.service, and
    # `huggingface-cli download --local-dir <path>` writes files at whatever
    # path it is handed. A `../`-laden repo id must never be able to walk
    # that write target outside the managed cache root.
    escaping_repo = "../../../../etc/cron.d"
    action = make_action("pull_model", "vllm", model_repo=escaping_repo)

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    # No download command was ever issued for a path outside the cache root.
    run.assert_not_called()
    assert result.exit_code != 0
    assert "refusing to pull" in result.stderr


def test_vllm_pull_rejects_an_absolute_repo_id_that_would_replace_the_cache_root():
    # os.path.join(cache_root, "/etc/cron.d") discards cache_root entirely
    # because the second argument is absolute, so the download would land
    # directly in /etc/cron.d as root. Containment must catch this too, not
    # just relative `../` traversal.
    action = make_action("pull_model", "vllm", model_repo="/etc/cron.d")

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    run.assert_not_called()
    assert result.exit_code != 0


def test_vllm_pull_rejects_a_repo_id_that_resolves_to_the_cache_root_itself():
    action = make_action("pull_model", "vllm", model_repo="")

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    run.assert_not_called()
    assert result.exit_code != 0


def test_vllm_pull_refuses_a_missing_repo_id_instead_of_raising():
    # A vLLM model declared with the Ollama `name` form reaches here with
    # model_repo=None. `os.path.join(str, None)` used to raise TypeError,
    # which main.py's bare `except Exception` swallowed — no convergence
    # report was ever sent and the console showed nothing at all.
    action = make_action("pull_model", "vllm", model_repo=None)

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    run.assert_not_called()
    assert result.exit_code != 0


def test_vllm_pull_writes_only_inside_the_managed_cache_path():
    action = make_action("pull_model", "vllm", model_repo="org/some-model")

    with patch("zllama_agent.models.subprocess.run", return_value=mock_run(0)) as run:
        result = VLLM_MODEL_EXECUTORS["pull_model"](action)

    assert result.exit_code == 0
    argv = run.call_args.args[0]
    local_dir = argv[argv.index("--local-dir") + 1]
    assert local_dir.startswith(VLLM_MODEL_CACHE_ROOT + "/")


def test_vllm_remove_deletes_only_inside_the_managed_cache_path():
    action = make_action("remove_model", "vllm", model_repo="org/some-model")

    with patch("zllama_agent.models.subprocess.run", return_value=mock_run(0)) as run:
        result = VLLM_MODEL_EXECUTORS["remove_model"](action)

    assert result.exit_code == 0
    call = run.call_args
    assert isinstance(call.args[0], list)
    assert call.kwargs.get("shell") is not True
    target = call.args[0][-1]
    assert target.startswith(VLLM_MODEL_CACHE_ROOT + "/")


def test_vllm_remove_rejects_a_repo_id_that_would_escape_the_cache_root_via_traversal():
    # THE most important test in this module: vLLM "remove" deletes a
    # directory as root. A repo id containing `../` must never be able to
    # walk the delete target outside the managed cache root. If the
    # containment check in `_resolve_within_cache_root` were removed or
    # weakened, this test must fail — it asserts both that no delete
    # command was ever issued, and that the exit code reports the refusal
    # rather than silently succeeding.
    escaping_repo = "../../../../etc/cron.d"
    action = make_action("remove_model", "vllm", model_repo=escaping_repo)

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["remove_model"](action)

    # No delete command was ever issued for a path outside the cache root.
    run.assert_not_called()
    assert result.exit_code != 0
    assert "etc/cron.d" not in result.stdout


def test_vllm_remove_rejects_an_absolute_repo_id_that_would_replace_the_cache_root():
    # os.path.join(cache_root, "/etc/passwd") discards cache_root entirely
    # because the second argument is absolute — the containment check must
    # catch this too, not just relative `../` traversal.
    action = make_action("remove_model", "vllm", model_repo="/etc/passwd")

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["remove_model"](action)

    run.assert_not_called()
    assert result.exit_code != 0


def test_vllm_remove_rejects_a_repo_id_that_resolves_to_the_cache_root_itself():
    # An empty or malformed repo id must not end up deleting the entire
    # managed cache root — only a strict subdirectory of it is ever a
    # valid delete target for one model.
    action = make_action("remove_model", "vllm", model_repo="")

    with patch("zllama_agent.models.subprocess.run") as run:
        result = VLLM_MODEL_EXECUTORS["remove_model"](action)

    run.assert_not_called()
    assert result.exit_code != 0


def test_vllm_remove_has_an_explicit_timeout_when_it_does_delete():
    action = make_action("remove_model", "vllm", model_repo="org/some-model")
    with patch("zllama_agent.models.subprocess.run", return_value=mock_run(0)) as run:
        VLLM_MODEL_EXECUTORS["remove_model"](action)

    assert run.call_args.kwargs.get("timeout") is not None
    assert run.call_args.kwargs["timeout"] > 0


def test_vllm_remove_non_zero_exit_is_returned_not_raised():
    action = make_action("remove_model", "vllm", model_repo="org/some-model")
    with patch(
        "zllama_agent.models.subprocess.run", return_value=mock_run(1, "", "permission denied")
    ):
        result = VLLM_MODEL_EXECUTORS["remove_model"](action)

    assert result.exit_code == 1
    assert "permission denied" in result.stderr


def test_both_model_executor_maps_cover_exactly_the_closed_model_action_set():
    assert set(OLLAMA_MODEL_EXECUTORS) == MODEL_ACTION_KINDS
    assert set(VLLM_MODEL_EXECUTORS) == MODEL_ACTION_KINDS
