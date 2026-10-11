"""Proves the agent package is actually pip-installable.

Regression test for the flat-layout packaging bug: `agent/` ships both
`zllama_agent/` (the package) and `systemd/` (the unit file, for install.sh)
at the top level. setuptools' automatic package discovery sees two
top-level candidates and refuses to guess, so `pip install agent/` failed
outright on a real host with:

    error: Multiple top-level packages discovered in a flat-layout:
    ['systemd', 'zllama_agent'].

Unlike test_config.py etc. (which only import the already-installed
package from the repo checkout), this test genuinely runs `pip install`
against `agent/pyproject.toml` from scratch into a throwaway directory, so
it fails against a pyproject.toml that relies on unguided flat-layout
discovery and passes once the package list is declared explicitly. Text
assertions on pyproject.toml's contents would not catch this class of bug.

Uses `pip install --target ... --no-deps --no-build-isolation` rather than
a full venv build: `--no-deps` skips dependency resolution/download (the
runtime-dependencies wiring isn't what's under test — package discovery
is), and `--no-build-isolation` reuses this interpreter's already-installed
setuptools instead of provisioning a fresh build environment for
build-system.requires. Both together mean the test needs no network access
and stays fast enough for the default suite, while still exercising the
exact step (setuptools package discovery) that broke in the field.

Never touches /opt, /etc, or /var — installs only into pytest's tmp_path.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

AGENT_DIR = Path(__file__).parent.parent


def _missing_prereqs() -> list[str]:
    missing = []
    for mod in ("pip", "setuptools"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    return missing


_MISSING = _missing_prereqs()


@pytest.mark.skipif(
    bool(_MISSING),
    reason=f"pip/setuptools not importable in this interpreter: {_MISSING}",
)
def test_pip_install_target_discovers_and_installs_zllama_agent(tmp_path):
    # setuptools drops build/ and *.egg-info next to pyproject.toml while
    # building a wheel, regardless of where --target points the install.
    # Build from a throwaway copy so this test never writes into the real
    # agent/ source tree.
    source_copy = tmp_path / "agent-src"
    shutil.copytree(
        AGENT_DIR,
        source_copy,
        ignore=shutil.ignore_patterns(
            "__pycache__", "*.pyc", ".pytest_cache", ".ruff_cache", "build", "*.egg-info"
        ),
    )

    target = tmp_path / "install-target"
    target.mkdir()

    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--target",
            str(target),
            "--no-deps",
            "--no-build-isolation",
            "--quiet",
            "--disable-pip-version-check",
            str(source_copy),
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )

    if result.returncode != 0 and (
        "Could not find a version" in result.stderr
        or "Network is unreachable" in result.stderr
        or "Temporary failure in name resolution" in result.stderr
    ):
        pytest.skip(
            "pip install could not run without network access in this "
            f"environment:\n{result.stderr}"
        )

    assert result.returncode == 0, (
        "pip install of agent/ failed (this is defect 1 if you see a "
        "'Multiple top-level packages discovered in a flat-layout' error):\n"
        f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
    )

    # Import from the install location in a subprocess, isolated from this
    # test process's own sys.path/import cache and from the repo checkout
    # (which would otherwise shadow the installed copy via editable state).
    env = dict(os.environ)
    env["PYTHONPATH"] = str(target)
    import_check = subprocess.run(
        [
            sys.executable,
            "-c",
            "import zllama_agent\n"
            "from zllama_agent.config import load_config\n"
            "print('IMPORT_OK')\n",
        ],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(tmp_path),
        timeout=30,
    )

    assert import_check.returncode == 0 and "IMPORT_OK" in import_check.stdout, (
        "importing zllama_agent / zllama_agent.config.load_config from the "
        "pip-installed location failed:\n"
        f"--- stdout ---\n{import_check.stdout}\n--- stderr ---\n{import_check.stderr}"
    )

    # systemd/ is shipped in the served tarball (install.sh needs the unit
    # file) but must not become part of the installed Python package.
    assert not (target / "systemd").exists()
    assert (target / "zllama_agent").is_dir()

    shutil.rmtree(target, ignore_errors=True)
