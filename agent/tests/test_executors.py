"""Tests for the Ollama and vLLM executors.

`subprocess.run` and `urllib.request.urlopen` are mocked throughout — no test
here executes a real installer, service command, pip install, or HTTP request.
`tests/conftest.py` blocks both suite-wide as a backstop, along with the
sleeps between post-condition retries.
"""

import json
import urllib.error
from unittest.mock import MagicMock, patch

import zllama_agent.executors as executors_module
from zllama_agent.converge import RUNTIME_ACTION_KINDS, Action
from zllama_agent.executors import OLLAMA_EXECUTORS, VLLM_EXECUTORS, VLLM_VENV_PATH


def make_action(kind, runtime, target_version=None, reason="test"):
    return Action(kind=kind, runtime=runtime, target_version=target_version, reason=reason)


def mock_run(returncode=0, stdout="", stderr=""):
    result = MagicMock()
    result.returncode = returncode
    result.stdout = stdout
    result.stderr = stderr
    return result


def api_version_body(version):
    """A stand-in for what `urlopen` yields for `GET /api/version`."""
    response = MagicMock()
    response.read.return_value = json.dumps({"version": version}).encode("utf-8")
    context = MagicMock()
    context.__enter__.return_value = response
    return context


def patch_ollama_api(version):
    """Patch the post-condition probe. `version=None` means nothing is
    listening — the daemon never answers at all."""
    if version is None:
        return patch(
            "urllib.request.urlopen",
            side_effect=urllib.error.URLError("connection refused"),
        )
    return patch(
        "urllib.request.urlopen",
        return_value=api_version_body(version),
    )


def ollama_commands(*, unit_exists=True, install_code=0, restart_code=0):
    """A `subprocess.run` side effect covering the three commands the Ollama
    install path can issue: the shell installer, the unit probe, the restart."""

    def side_effect(args, **_kwargs):
        if isinstance(args, str):
            return mock_run(install_code, "installed", "" if install_code == 0 else "boom")
        if args[:2] == ["systemctl", "cat"]:
            return mock_run(0 if unit_exists else 1)
        if args[:2] == ["systemctl", "restart"]:
            return mock_run(restart_code, "", "" if restart_code == 0 else "restart refused")
        return mock_run(0)

    return side_effect


def patch_systemctl(present=True):
    return patch(
        "zllama_agent.executors.shutil.which",
        return_value="/usr/bin/systemctl" if present else None,
    )


def issued_commands(run):
    """Every command handed to `subprocess.run`, as strings for easy matching."""
    return [
        call.args[0] if isinstance(call.args[0], str) else " ".join(call.args[0])
        for call in run.call_args_list
    ]


def test_both_executor_maps_cover_exactly_the_closed_runtime_action_set():
    assert set(OLLAMA_EXECUTORS) == RUNTIME_ACTION_KINDS
    assert set(VLLM_EXECUTORS) == RUNTIME_ACTION_KINDS


# --- Ollama ----------------------------------------------------------------


def test_ollama_install_runs_the_official_install_script_via_shell_and_returns_exit_code():
    action = make_action("install_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api("0.32.13"),
    ):
        result = OLLAMA_EXECUTORS["install_runtime"](action)

    assert result.exit_code == 0
    installer_call = run.call_args_list[0]
    assert installer_call.kwargs["shell"] is True
    assert isinstance(installer_call.args[0], str)
    assert "install.sh" in installer_call.args[0]


def test_ollama_upgrade_uses_the_same_installer_path_as_install_and_is_idempotent():
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api("0.32.13"),
    ):
        OLLAMA_EXECUTORS["upgrade_runtime"](make_action("upgrade_runtime", "ollama"))
    upgrade_command = run.call_args_list[0].args[0]

    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run2,
        patch_ollama_api("0.32.13"),
    ):
        OLLAMA_EXECUTORS["install_runtime"](make_action("install_runtime", "ollama"))
    install_command = run2.call_args_list[0].args[0]

    assert upgrade_command == install_command


def test_ollama_remove_stops_service_and_removes_binary_but_never_touches_model_path():
    action = make_action("remove_runtime", "ollama")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", return_value=mock_run(0)) as run,
    ):
        result = OLLAMA_EXECUTORS["remove_runtime"](action)

    assert result.exit_code == 0
    commands = issued_commands(run)
    assert any("systemctl" in c and "stop" in c for c in commands)
    assert any("rm" in c and "ollama" in c for c in commands)
    for c in commands:
        assert "models" not in c
        assert ".ollama" not in c


def test_ollama_remove_uses_argument_lists_never_shell():
    action = make_action("remove_runtime", "ollama")
    with (
        patch_systemctl(present=False),
        patch("zllama_agent.executors.subprocess.run", return_value=mock_run(0)) as run,
    ):
        OLLAMA_EXECUTORS["remove_runtime"](action)

    for call in run.call_args_list:
        assert isinstance(call.args[0], list)
        assert call.kwargs.get("shell") is not True


def test_a_nonzero_exit_code_is_returned_as_is_not_raised():
    action = make_action("install_runtime", "ollama")
    with patch(
        "zllama_agent.executors.subprocess.run", return_value=mock_run(1, "", "install failed")
    ):
        result = OLLAMA_EXECUTORS["install_runtime"](action)
    assert result.exit_code == 1


def test_captured_stderr_is_included_in_the_result():
    action = make_action("install_runtime", "ollama")
    with patch("zllama_agent.executors.subprocess.run", return_value=mock_run(1, "", "boom")):
        result = OLLAMA_EXECUTORS["install_runtime"](action)
    assert "boom" in result.stderr


def test_a_failed_installer_never_restarts_the_service_or_probes_the_api():
    action = make_action("install_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=ollama_commands(install_code=1),
        ) as run,
        patch_ollama_api("0.32.13") as urlopen,
    ):
        result = OLLAMA_EXECUTORS["install_runtime"](action)

    assert result.exit_code == 1
    assert not any("systemctl" in c for c in issued_commands(run))
    assert urlopen.call_count == 0


def test_ollama_install_never_interpolates_the_target_version_into_the_shell_string():
    # This is the injection boundary: the fixed shell command string must
    # never contain a declaration value, no matter what that value is.
    malicious_version = "0.1; rm -rf /"
    action = make_action("install_runtime", "ollama", target_version=malicious_version)
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api(malicious_version),
    ):
        OLLAMA_EXECUTORS["install_runtime"](action)

    installer_call = run.call_args_list[0]
    command_string = installer_call.args[0]
    assert malicious_version not in command_string
    assert installer_call.kwargs["shell"] is True

    # The version reaches the installer only via an environment variable —
    # never through shell string interpolation, so it is never parsed as
    # a shell command.
    env = installer_call.kwargs.get("env") or {}
    assert env.get("OLLAMA_VERSION") == malicious_version

    # And no *other* command in the path ever sees it either.
    for call in run.call_args_list[1:]:
        assert isinstance(call.args[0], list)
        assert call.kwargs.get("shell") is not True
        assert malicious_version not in " ".join(call.args[0])


def test_every_ollama_subprocess_call_has_an_explicit_positive_timeout():
    action = make_action("remove_runtime", "ollama")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", return_value=mock_run(0)) as run,
    ):
        OLLAMA_EXECUTORS["remove_runtime"](action)

    assert run.call_args_list
    for call in run.call_args_list:
        assert call.kwargs.get("timeout") is not None
        assert call.kwargs["timeout"] > 0


# --- Ollama upgrade post-condition -----------------------------------------
#
# The defect these cover, observed on a live host: Ollama's installer replaces
# the binary but does not restart a running service, so the daemon kept
# serving 0.32.3 while the executor reported exit 0. Planning re-planned the
# upgrade every 30s and backoff — which keys on failure — never engaged. The
# installer ran 13 times in 12 minutes.


def test_upgrade_restarts_the_service_and_verifies_the_serving_version():
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api("0.32.13") as urlopen,
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code == 0

    restart_calls = [
        call
        for call in run.call_args_list
        if isinstance(call.args[0], list) and call.args[0][:2] == ["systemctl", "restart"]
    ]
    assert len(restart_calls) == 1
    restart = restart_calls[0]
    assert restart.args[0] == ["systemctl", "restart", "ollama"]
    assert restart.kwargs.get("shell") is not True
    # A stop with a large model resident can outlast the 30s service timeout.
    assert restart.kwargs["timeout"] == executors_module.RESTART_TIMEOUT_SECONDS
    assert executors_module.RESTART_TIMEOUT_SECONDS == 120

    assert urlopen.call_count >= 1
    probed = urlopen.call_args.args[0]
    assert probed.full_url == "http://127.0.0.1:11434/api/version"
    assert urlopen.call_args.kwargs["timeout"] > 0
    assert "0.32.13" in result.stdout


def test_upgrade_fails_when_the_api_keeps_serving_the_old_version():
    # The live bug, reproduced: the installer exits 0, the restart is issued,
    # and the daemon is *still* serving the old version. Exit 0 is not
    # success; only a nonzero result puts this action into backoff.
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api("0.32.3") as urlopen,
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code != 0, (
        "an upgrade whose serving version never changed must be reported as "
        "FAILED; reporting success is what looped the installer 13 times"
    )
    assert any(
        isinstance(call.args[0], list) and call.args[0][:2] == ["systemctl", "restart"]
        for call in run.call_args_list
    )
    assert urlopen.call_count >= 1

    stderr = result.stderr
    assert "exited 0" in stderr  # what the installer reported
    assert "0.32.13" in stderr  # what was declared / installed
    assert "0.32.3" in stderr  # what is actually being served
    assert "restarted" in stderr


def test_upgrade_skips_the_restart_when_there_is_no_systemd_unit():
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=ollama_commands(unit_exists=False),
        ) as run,
        patch_ollama_api("0.32.13"),
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    # Ollama may legitimately run some other way; a missing unit is not an
    # error, because the post-condition still decides success honestly.
    assert result.exit_code == 0
    assert not any("restart" in c for c in issued_commands(run))


def test_upgrade_skips_the_restart_when_systemctl_is_absent_entirely():
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(present=False),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()) as run,
        patch_ollama_api("0.32.13"),
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code == 0
    assert not any("systemctl" in c for c in issued_commands(run))


def test_upgrade_fails_when_the_api_never_answers_after_a_restart():
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()),
        patch_ollama_api(None) as urlopen,
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code != 0
    assert urlopen.call_count > 1, "the probe must be retried while the service comes back"
    assert "did not answer" in result.stderr
    assert "restarted" in result.stderr


def test_a_bare_present_declaration_succeeds_as_soon_as_the_api_answers():
    # No version declared, so there is nothing to compare against: the
    # post-condition is only that the runtime is actually serving.
    action = make_action("install_runtime", "ollama", target_version=None)
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()),
        patch_ollama_api("0.32.3") as urlopen,
    ):
        result = OLLAMA_EXECUTORS["install_runtime"](action)

    assert result.exit_code == 0
    assert urlopen.call_count == 1
    assert "0.32.3" in result.stdout


def test_a_failed_restart_fails_the_action():
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=ollama_commands(restart_code=1),
        ),
        patch_ollama_api("0.32.13"),
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code != 0
    assert "restart refused" in result.stderr


def test_the_post_condition_probe_honours_ollama_host(monkeypatch):
    monkeypatch.setenv("OLLAMA_HOST", "10.10.0.4:11500")
    action = make_action("upgrade_runtime", "ollama", target_version="0.32.13")
    with (
        patch_systemctl(),
        patch("zllama_agent.executors.subprocess.run", side_effect=ollama_commands()),
        patch_ollama_api("0.32.13") as urlopen,
    ):
        result = OLLAMA_EXECUTORS["upgrade_runtime"](action)

    assert result.exit_code == 0
    assert urlopen.call_args.args[0].full_url == "http://10.10.0.4:11500/api/version"


def test_ollama_api_base_forms(monkeypatch):
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    assert executors_module._ollama_api_base() == "http://127.0.0.1:11434"

    monkeypatch.setenv("OLLAMA_HOST", "https://10.0.0.9:11434/")
    assert executors_module._ollama_api_base() == "https://10.0.0.9:11434"

    # A bare host must not fall through to urllib's implicit port 80.
    monkeypatch.setenv("OLLAMA_HOST", "10.0.0.9")
    assert executors_module._ollama_api_base() == "http://10.0.0.9:11434"


# --- vLLM --------------------------------------------------------------


def vllm_commands(*, imported_version="0.5.0", import_code=0, pip_code=0):
    def side_effect(args, **_kwargs):
        if "-c" in args:
            return mock_run(import_code, f"{imported_version}\n", "")
        if len(args) > 1 and args[1] == "install":
            return mock_run(pip_code, "ok", "" if pip_code == 0 else "pip failed")
        return mock_run(0, "ok")

    return side_effect


def test_vllm_install_creates_a_managed_venv_and_pip_installs_a_pinned_version():
    action = make_action("install_runtime", "vllm", target_version="0.5.0")
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch("zllama_agent.executors.subprocess.run", side_effect=vllm_commands()) as run,
    ):
        result = VLLM_EXECUTORS["install_runtime"](action)

    assert result.exit_code == 0
    calls = [call.args[0] for call in run.call_args_list]
    assert any("venv" in c and VLLM_VENV_PATH in c for c in calls)
    assert any("vllm==0.5.0" in c for c in calls)


def test_vllm_install_fails_when_the_venv_imports_a_different_version_than_declared():
    # pip's exit code says only that pip ran. The post-condition is that the
    # managed venv actually imports the pinned version.
    action = make_action("install_runtime", "vllm", target_version="0.5.0")
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=vllm_commands(imported_version="0.4.2"),
        ) as run,
    ):
        result = VLLM_EXECUTORS["install_runtime"](action)

    assert result.exit_code != 0
    assert "0.5.0" in result.stderr
    assert "0.4.2" in result.stderr

    verify_calls = [call for call in run.call_args_list if "-c" in call.args[0]]
    assert len(verify_calls) == 1
    verify = verify_calls[0]
    assert isinstance(verify.args[0], list)
    assert verify.kwargs.get("shell") is not True
    assert verify.kwargs["timeout"] > 0
    assert verify.args[0][0].startswith(VLLM_VENV_PATH)


def test_vllm_install_fails_when_the_venv_cannot_import_vllm_at_all():
    action = make_action("install_runtime", "vllm", target_version="0.5.0")
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=vllm_commands(import_code=1, imported_version=""),
        ),
    ):
        result = VLLM_EXECUTORS["install_runtime"](action)

    assert result.exit_code != 0
    assert "0.5.0" in result.stderr


def test_vllm_install_without_a_declared_version_does_not_verify_a_version():
    action = make_action("install_runtime", "vllm", target_version=None)
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch("zllama_agent.executors.subprocess.run", side_effect=vllm_commands()) as run,
    ):
        result = VLLM_EXECUTORS["install_runtime"](action)

    assert result.exit_code == 0
    assert not any("-c" in call.args[0] for call in run.call_args_list)


def test_vllm_install_method_differs_between_aarch64_and_x86_64():
    action = make_action("install_runtime", "vllm", target_version="0.5.0")

    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch("zllama_agent.executors.subprocess.run", side_effect=vllm_commands()),
    ):
        x86_result = VLLM_EXECUTORS["install_runtime"](action)

    with (
        patch("zllama_agent.executors.platform.machine", return_value="aarch64"),
        patch("zllama_agent.executors.subprocess.run", side_effect=vllm_commands()),
    ):
        arm_result = VLLM_EXECUTORS["install_runtime"](action)

    x86_method = x86_result.stdout.splitlines()[0]
    arm_method = arm_result.stdout.splitlines()[0]
    assert x86_method.startswith("install_method=")
    assert arm_method.startswith("install_method=")
    assert x86_method != arm_method


def test_vllm_install_never_reaches_a_shell_with_a_malicious_version():
    # The injection boundary for vLLM: the pinned version is a single argv
    # element, so it can never be parsed as a shell command even when it
    # contains shell metacharacters.
    malicious_version = "0.1; rm -rf /"
    action = make_action("install_runtime", "vllm", target_version=malicious_version)
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch(
            "zllama_agent.executors.subprocess.run",
            side_effect=vllm_commands(imported_version=malicious_version),
        ) as run,
    ):
        VLLM_EXECUTORS["install_runtime"](action)

    for call in run.call_args_list:
        assert isinstance(call.args[0], list)
        assert call.kwargs.get("shell") is not True

    pip_call = next(call for call in run.call_args_list if "pip" in call.args[0][0])
    pip_args = pip_call.args[0]

    matching = [arg for arg in pip_args if malicious_version in arg]
    assert len(matching) == 1
    assert matching[0] == f"vllm=={malicious_version}"
    # And it was never handed to a shell to interpret.
    assert pip_call.kwargs.get("shell") is not True


def test_every_vllm_subprocess_call_has_an_explicit_positive_timeout():
    action = make_action("install_runtime", "vllm", target_version="0.5.0")
    with (
        patch("zllama_agent.executors.platform.machine", return_value="x86_64"),
        patch("zllama_agent.executors.subprocess.run", side_effect=vllm_commands()) as run,
    ):
        VLLM_EXECUTORS["install_runtime"](action)

    assert run.call_args_list
    for call in run.call_args_list:
        assert call.kwargs.get("timeout") is not None
        assert call.kwargs["timeout"] > 0


def test_vllm_remove_deletes_the_managed_venv_via_an_argument_list():
    action = make_action("remove_runtime", "vllm")
    with patch("zllama_agent.executors.subprocess.run", return_value=mock_run(0)) as run:
        result = VLLM_EXECUTORS["remove_runtime"](action)

    assert result.exit_code == 0
    call = run.call_args
    assert isinstance(call.args[0], list)
    assert call.kwargs.get("shell") is not True
    assert VLLM_VENV_PATH in call.args[0]
