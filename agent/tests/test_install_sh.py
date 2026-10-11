"""Contract tests for install.sh, read as text — never executed.

The installer mutates the host it runs on (creates a venv, writes a system
config file, installs a systemd unit), so these tests only assert on the
script's source rather than running it.
"""

import pathlib

INSTALL_SH = pathlib.Path(__file__).parent.parent / "install.sh"
SERVICE_UNIT = pathlib.Path(__file__).parent.parent / "systemd" / "zllama-agent.service"


def read_script() -> str:
    return INSTALL_SH.read_text(encoding="utf-8")


def read_service_unit() -> str:
    return SERVICE_UNIT.read_text(encoding="utf-8")


def test_script_exists_and_is_executable():
    assert INSTALL_SH.exists()
    assert INSTALL_SH.stat().st_mode & 0o111, "install.sh must be executable"


def test_sets_strict_mode():
    text = read_script()
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    assert "set -euo pipefail" in lines


def test_writes_config_with_mode_0600():
    text = read_script()
    assert "chmod 0600" in text
    assert "agent.yaml" in text


def test_writes_converge_false():
    text = read_script()
    assert "converge: false" in text


def test_refuses_to_run_without_token():
    text = read_script()
    assert '-z "$TOKEN"' in text
    assert "exit 1" in text


def test_refuses_to_run_without_server():
    text = read_script()
    assert '-z "$SERVER"' in text


def test_does_not_hardcode_a_token():
    text = read_script()
    # The token is only ever the operator-supplied ${TOKEN} variable, never a
    # literal value baked into the script.
    assert 'TOKEN=""' in text
    assert "token: ${TOKEN}" in text


def test_takes_token_and_server_flags():
    text = read_script()
    assert "--token" in text
    assert "--server" in text


def test_installs_and_enables_systemd_unit():
    text = read_script()
    assert "systemctl enable" in text
    assert "zllama-agent.service" in text


def test_idempotent_venv_creation_is_guarded():
    text = read_script()
    assert '[[ ! -d "$VENV_DIR" ]]' in text


def test_downloads_the_agent_package_from_the_server():
    text = read_script()
    # The operator does not pre-copy the source tree: install.sh fetches it
    # from the same server the agent will report to.
    assert "/api/agent/package" in text
    assert 'PACKAGE_URL="${SERVER}/api/agent/package"' in text
    assert "tar -xzf -" in text


def test_downloads_before_creating_the_venv():
    text = read_script()
    assert text.index("tar -xzf -") < text.index('[[ ! -d "$VENV_DIR" ]]')


def test_installs_the_package_from_the_downloaded_source():
    text = read_script()
    assert 'install --upgrade "$SRC_DIR"' in text
    assert 'SRC_DIR="${INSTALL_DIR}/agent"' in text


def test_installs_the_unit_from_the_downloaded_source():
    text = read_script()
    assert '"${SRC_DIR}/systemd/zllama-agent.service"' in text


def test_download_falls_back_when_curl_is_absent():
    text = read_script()
    assert "command -v curl" in text
    assert "command -v wget" in text


def test_redownload_is_idempotent():
    text = read_script()
    # A re-run must not append to or merge with a previous extraction.
    assert 'rm -rf "$SRC_DIR"' in text


def test_takes_a_repeatable_vllm_model_path_flag():
    text = read_script()
    assert "--vllm-model-path" in text
    assert "VLLM_MODEL_PATHS+=" in text


def test_vllm_model_paths_are_written_as_a_yaml_list():
    text = read_script()
    assert 'echo "vllm_model_paths:"' in text
    assert "printf '  - %s\\n' \"$model_path\"" in text


def test_vllm_model_paths_block_is_omitted_when_no_flags_given():
    text = read_script()
    assert "if [[ ${#VLLM_MODEL_PATHS[@]} -gt 0 ]]; then" in text


def test_config_is_chmodded_after_the_vllm_model_paths_block_is_appended():
    text = read_script()
    # The mode-0600 chmod must be the last write to the config file, so an
    # appended vllm_model_paths block can never leave the file world/group
    # readable even momentarily.
    assert text.index("vllm_model_paths:") < text.rindex("chmod 0600")


def test_documents_bash_not_sh_for_the_piped_one_liner():
    text = read_script()
    # `set -euo pipefail` (asserted above) is bash-only. Piping this script
    # to a plain POSIX shell (`| sudo sh -s --`), as a stale doc once told
    # operators to do, fails immediately on Ubuntu (dash) with
    # "set: Illegal option -o pipefail". The documented one-liner must say
    # bash, and must not tell anyone to pipe it through `sh`.
    assert "bash -s --" in text
    assert "sudo sh -s" not in text
    assert "| sh " not in text
    assert not text.rstrip().endswith("| sh")


# --- `$HOME` under a root systemd service -----------------------------------
#
# Root systemd services get no `$HOME` at all, which panics `ollama
# --version` (`envconfig.Models()` reads `$HOME` directly). facts.py now
# defaults `HOME` on the `env=` it hands every runtime-CLI subprocess call
# (belt), but the unit itself should also set `HOME` directly (suspenders) —
# it fixes any other HOME-dependent tool the agent or a converge action might
# invoke, not just Ollama.


def test_service_unit_sets_home_for_root():
    text = read_service_unit()
    assert "Environment=HOME=/root" in text


def test_install_sh_installs_the_unit_verbatim_from_the_downloaded_source():
    # install.sh doesn't need its own HOME= line: it copies
    # systemd/zllama-agent.service from the downloaded source tree as-is, so
    # the fix above already reaches every host `install.sh` provisions.
    text = read_script()
    assert '"${SRC_DIR}/systemd/zllama-agent.service"' in text
    assert 'cp "${SRC_DIR}/systemd/zllama-agent.service" "$UNIT_FILE"' in text


# --- Broken venv recreation and actionable venv-creation failures -----------
#
# Two real failures hit on the 8-host fleet: (1) a venv was created but
# ensurepip failed, leaving no `bin/pip` — re-running install.sh treated the
# venv directory's mere existence as "already installed" and died later at
# `pip: No such file or directory`; (2) `python3 -m venv` itself failed on
# two Ubuntu hosts missing the `python3.X-venv` package, and the script died
# with a bare traceback instead of naming what to install.


def test_broken_venv_missing_pip_is_detected_and_recreated():
    text = read_script()
    assert '-x "${VENV_DIR}/bin/pip"' in text
    # The detection must actually remove the broken venv, not just warn.
    detect_index = text.index('-x "${VENV_DIR}/bin/pip"')
    assert 'rm -rf "$VENV_DIR"' in text[detect_index:]


def test_venv_creation_failure_names_the_venv_package_to_install():
    text = read_script()
    # The message must be derived from the running python3's own version,
    # never a hardcoded version that would go stale on a different Ubuntu
    # release.
    assert "sys.version_info.minor" in text
    assert "-venv" in text
    assert "apt-get install" in text


def test_venv_creation_failure_is_checked_before_pip_is_ever_invoked():
    text = read_script()
    assert text.index("python3 -m venv") < text.index('"${VENV_DIR}/bin/pip" install')
