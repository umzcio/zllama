"""Ollama and vLLM runtime executors.

Each of `OLLAMA_EXECUTORS` / `VLLM_EXECUTORS` maps the three closed action
kinds (`install_runtime`, `upgrade_runtime`, `remove_runtime`) to a callable
`(action: Action) -> ExecutorResult`. `converge.py` never touches a
subprocess itself; this is the one module where that happens.

Safety rules enforced throughout this file:
  - Every command is built as an argument list and run without a shell,
    with exactly one documented exception: Ollama's official installer,
    which only works piped into a shell. Even there, the
    command string itself is a fixed constant — a declared version is
    delivered via the `OLLAMA_VERSION` environment variable (which Ollama's
    installer reads), never spliced into the command string. A value
    containing shell metacharacters is therefore inert.
  - Every other version value is passed as its own, single argv element
    (e.g. `vllm==<version>`) in an argument list — never through a shell.
  - Every call carries an explicit timeout so a hung installer cannot wedge
    the agent forever. That includes the HTTP post-condition probe below:
    `urlopen` has no default timeout, so one is always passed.
  - **An exit code of 0 is not success.** An install or upgrade only
    succeeds when its post-condition is verified afterwards: the runtime is
    actually *serving* the declared version. See `_ollama_install_or_upgrade`
    for why (a live host proved it), and note that this is what lets
    `backoff.py` engage — backoff keys on failure, so an action that lies
    about succeeding is invisible to it and loops forever.
  - Removing the Ollama runtime stops the service and deletes the binary,
    and never touches the model directory: models are large and expensive
    to re-download, and uninstalling a runtime is not a request to destroy
    data.
"""

import json
import logging
import os
import platform
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from typing import Callable

from zllama_agent.converge import Action, ExecutorResult

logger = logging.getLogger(__name__)

INSTALL_TIMEOUT_SECONDS = 600
SERVICE_TIMEOUT_SECONDS = 30
REMOVE_TIMEOUT_SECONDS = 30
# Deliberately *not* SERVICE_TIMEOUT_SECONDS: stopping an ollama service with
# a large model resident can take well over 30s, and a restart killed at its
# timeout would leave the host worse off than before.
RESTART_TIMEOUT_SECONDS = 120

# The post-condition probe. Short per-request timeout, retried across a ~30s
# window so a service that is still coming back up after a restart is given a
# fair chance to answer before the action is called a failure.
VERSION_PROBE_TIMEOUT_SECONDS = 5
VERSION_PROBE_ATTEMPTS = 6
VERSION_PROBE_INTERVAL_SECONDS = 5

# Exit code reported when a command exited 0 but its post-condition does not
# hold. It is deliberately nonzero: `converge._execute` only records a
# backoff entry for a nonzero exit, so this is the value that makes a
# never-converging action cool down instead of re-running every cycle.
POSTCONDITION_EXIT_CODE = 1

# The single fixed command string for the one shell-invoking call in this
# file. It never contains a declaration value — see module docstring.
OLLAMA_INSTALL_SCRIPT_COMMAND = "curl -fsSL https://ollama.com/install.sh | sh"
OLLAMA_BINARY_PATH = "/usr/local/bin/ollama"
OLLAMA_SERVICE_NAME = "ollama"
OLLAMA_DEFAULT_API_BASE = "http://127.0.0.1:11434"
OLLAMA_DEFAULT_PORT = "11434"

VLLM_VENV_PATH = "/opt/zllama-agent/vllm-venv"
VLLM_VERIFY_TIMEOUT_SECONDS = 120


def _run(
    args, *, timeout: int, shell: bool = False, env: dict | None = None
) -> tuple[int, str, str]:
    """The one place in this module that calls `subprocess.run`.

    Always captures output as text and always sets a timeout; a
    `TimeoutExpired` is turned into a (non-raising) failed result rather
    than propagating, so a hung installer is reported, not left to wedge
    the caller.
    """
    try:
        result = subprocess.run(
            args,
            shell=shell,
            env=env,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or "" if isinstance(exc.stdout, str) else ""
        timeout_note = f"\ntimed out after {timeout}s"
        stderr = (exc.stderr or "" if isinstance(exc.stderr, str) else "") + timeout_note
        return 124, stdout, stderr


def _timed(fn: Callable[[], tuple[int, str, str]]) -> ExecutorResult:
    start = time.monotonic()
    exit_code, stdout, stderr = fn()
    duration_ms = int((time.monotonic() - start) * 1000)
    return ExecutorResult(
        exit_code=exit_code, stdout=stdout, stderr=stderr, duration_ms=duration_ms
    )


def _append(text: str, note: str) -> str:
    """Join executor output with a trailing note, tolerating empty output."""
    text = (text or "").rstrip("\n")
    return f"{text}\n{note}" if text else note


# --- Ollama ---------------------------------------------------------------


def _ollama_api_base() -> str:
    """Where this host's Ollama daemon is listening.

    Honours `OLLAMA_HOST` exactly as Ollama's own clients do — it may be a
    full URL (`http://10.0.0.4:11434`), a `host:port` pair, or a bare host —
    and falls back to loopback. A bare host gets Ollama's default port
    rather than urllib's implicit port 80, which would probe the wrong
    service entirely.
    """
    raw = (os.environ.get("OLLAMA_HOST") or "").strip()
    if not raw:
        return OLLAMA_DEFAULT_API_BASE
    if "://" not in raw:
        raw = f"http://{raw}"
    scheme, _, remainder = raw.partition("://")
    authority, slash, path = remainder.partition("/")
    if authority and ":" not in authority:
        authority = f"{authority}:{OLLAMA_DEFAULT_PORT}"
    return f"{scheme}://{authority}{slash}{path}".rstrip("/")


def _ollama_serving_version(base: str) -> str | None:
    """The version the local daemon is *serving*, from `GET /api/version`.

    `None` means the probe did not produce a version: nothing listening, a
    non-2xx status, an unparseable body, or a body without a `version`
    string. Total by construction — a probe failure is information, never an
    exception thrown at the caller.
    """
    url = f"{base}/api/version"
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=VERSION_PROBE_TIMEOUT_SECONDS) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.debug("ollama version probe failed for %s: %s", url, exc)
        return None
    if not isinstance(data, dict):
        return None
    version = data.get("version")
    return version if isinstance(version, str) and version else None


def _ollama_effective_version(base: str, target_version: str | None) -> str | None:
    """Poll `/api/version` until it answers (and, when a version was
    declared, until it answers *that* version) or the window runs out.

    Retrying serves two distinct cases: a service still coming back up after
    a restart answers nothing for a moment, and a service mid-restart can
    still be the old process answering the old version for a moment. Both
    are transient; a version that is still wrong at the end of the window is
    not. Returns the last thing observed, `None` if nothing ever answered.
    """
    observed: str | None = None
    for attempt in range(VERSION_PROBE_ATTEMPTS):
        observed = _ollama_serving_version(base)
        if observed is not None and (target_version is None or observed == target_version):
            return observed
        if attempt < VERSION_PROBE_ATTEMPTS - 1:
            time.sleep(VERSION_PROBE_INTERVAL_SECONDS)
    return observed


def _restart_ollama_service() -> tuple[bool, str, tuple[int, str] | None]:
    """Restart the ollama systemd unit after a successful install.

    Ollama's official installer replaces `/usr/local/bin/ollama` but does
    **not** restart an already-running service, so without this the new
    binary sits on disk while the old process keeps serving. Observed live:
    a 0.32.3 host "successfully" upgraded to 0.32.13 thirteen times in
    twelve minutes, its journal showing no stop/start for ollama at all.

    Skips the restart when there is no systemd, or no ollama unit under it —
    the runtime may legitimately be run another way (a container, a user
    session, by hand). That is not an error, because the post-condition
    check is what decides success either way.

    Returns `(restarted, note, error)`; `error` is `(exit_code, stderr)` only
    when a restart was actually attempted and failed.
    """
    if shutil.which("systemctl") is None:
        return False, "no systemctl on this host; skipped service restart", None

    unit_code, _, _ = _run(
        ["systemctl", "cat", OLLAMA_SERVICE_NAME], timeout=SERVICE_TIMEOUT_SECONDS
    )
    if unit_code != 0:
        return (
            False,
            f"no systemd unit named {OLLAMA_SERVICE_NAME!r}; skipped service restart",
            None,
        )

    code, _, err = _run(
        ["systemctl", "restart", OLLAMA_SERVICE_NAME], timeout=RESTART_TIMEOUT_SECONDS
    )
    if code != 0:
        return (
            False,
            f"systemctl restart {OLLAMA_SERVICE_NAME} exited {code}",
            (code, (err or "").strip()),
        )
    return True, f"restarted the {OLLAMA_SERVICE_NAME} service", None


def _ollama_install_or_upgrade(action: Action) -> ExecutorResult:
    """Run Ollama's official installer, restart the service, then verify.

    Idempotent, so install and upgrade share this one implementation —
    re-running it upgrades in place.

    The installer exiting 0 proves only that a binary was written. Success
    is the *post-condition*: the daemon answering `/api/version` with the
    declared version (or answering at all, when nothing was declared).
    Anything else is a failure with a nonzero exit code, which is what puts
    the action into failure backoff instead of re-running it every cycle.
    """
    env = dict(os.environ)
    if action.target_version:
        env["OLLAMA_VERSION"] = action.target_version
    target = action.target_version

    def run() -> tuple[int, str, str]:
        code, out, err = _run(
            OLLAMA_INSTALL_SCRIPT_COMMAND,
            shell=True,
            env=env,
            timeout=INSTALL_TIMEOUT_SECONDS,
        )
        if code != 0:
            return code, out, err

        restarted, note, restart_error = _restart_ollama_service()
        out = _append(out, note)
        if restart_error is not None:
            restart_code, restart_stderr = restart_error
            return (
                restart_code,
                out,
                _append(
                    err,
                    f"ollama {action.kind} failed: the installer exited 0 but {note}. "
                    f"{restart_stderr}",
                ),
            )

        base = _ollama_api_base()
        observed = _ollama_effective_version(base, target)
        declared = f"declared version {target!r}" if target else "no declared version"

        if observed is None:
            window = VERSION_PROBE_ATTEMPTS * VERSION_PROBE_INTERVAL_SECONDS
            return (
                POSTCONDITION_EXIT_CODE,
                out,
                _append(
                    err,
                    f"ollama {action.kind} post-condition failed: the installer "
                    f"exited 0 ({declared}) and the service was "
                    f"{'restarted' if restarted else 'not restarted'}, but "
                    f"{base}/api/version did not answer within {window}s. "
                    "Installer exit 0 alone is not success.",
                ),
            )

        out = _append(out, f"serving version {observed} at {base}")

        if target is not None and observed != target:
            return (
                POSTCONDITION_EXIT_CODE,
                out,
                _append(
                    err,
                    f"ollama {action.kind} post-condition failed: the installer "
                    f"exited 0 and installed the declared version {target!r}, but "
                    f"{base}/api/version is still serving {observed!r}. The service "
                    f"was {'restarted' if restarted else 'not restarted'}. "
                    "Installer exit 0 alone is not success: a running ollama "
                    "service keeps serving the old binary until it is restarted.",
                ),
            )

        return 0, out, err

    return _timed(run)


def _ollama_remove(_action: Action) -> ExecutorResult:
    """Stop the service and remove the binary. Never the model directory."""

    def run() -> tuple[int, str, str]:
        if shutil.which("systemctl"):
            _run(["systemctl", "stop", OLLAMA_SERVICE_NAME], timeout=SERVICE_TIMEOUT_SECONDS)
        return _run(["rm", "-f", OLLAMA_BINARY_PATH], timeout=REMOVE_TIMEOUT_SECONDS)

    return _timed(run)


OLLAMA_EXECUTORS: dict[str, Callable[[Action], ExecutorResult]] = {
    "install_runtime": _ollama_install_or_upgrade,
    "upgrade_runtime": _ollama_install_or_upgrade,
    "remove_runtime": _ollama_remove,
}


# --- vLLM ------------------------------------------------------------------


def _vllm_install_method() -> str:
    """Wheel availability differs between aarch64 and x86_64, so the fleet
    needs to know which path a given host took."""
    machine = platform.machine().lower()
    if machine in ("aarch64", "arm64"):
        return "pip-source-aarch64"
    return "pip-wheel-x86_64"


def _vllm_installed_version() -> str | None:
    """The version importable from the managed venv, or `None` if the import
    itself failed. An argument list with an explicit timeout — never a
    shell."""
    python_path = os.path.join(VLLM_VENV_PATH, "bin", "python")
    code, out, _ = _run(
        [python_path, "-c", "import vllm; print(vllm.__version__)"],
        timeout=VLLM_VERIFY_TIMEOUT_SECONDS,
    )
    version = (out or "").strip().splitlines()[-1].strip() if (out or "").strip() else ""
    if code != 0 or not version:
        return None
    return version


def _vllm_install_or_upgrade(action: Action) -> ExecutorResult:
    """Create a managed venv and pip-install a pinned version, then verify.

    The version is a single, discrete argv element (`vllm==<version>`)
    inside an argument list — never a shell string — so a value containing
    shell metacharacters is inert.

    As with Ollama, pip exiting 0 is not the success condition: when a
    version was declared, the venv must actually import that version.
    There is no service handling here — vLLM serving is external by
    design — but the same "zero is not unknown" rule applies to the
    post-condition.
    """
    method = _vllm_install_method()

    def run() -> tuple[int, str, str]:
        create_code, create_out, create_err = _run(
            ["python3", "-m", "venv", VLLM_VENV_PATH],
            timeout=INSTALL_TIMEOUT_SECONDS,
        )
        if create_code != 0:
            return create_code, create_out, create_err

        pip_path = os.path.join(VLLM_VENV_PATH, "bin", "pip")
        spec = f"vllm=={action.target_version}" if action.target_version else "vllm"
        code, out, err = _run([pip_path, "install", spec], timeout=INSTALL_TIMEOUT_SECONDS)
        out = f"install_method={method}\n{out}"
        if code != 0 or not action.target_version:
            return code, out, err

        observed = _vllm_installed_version()
        target = action.target_version
        if observed != target:
            return (
                POSTCONDITION_EXIT_CODE,
                _append(out, f"imported version {observed!r} from {VLLM_VENV_PATH}"),
                _append(
                    err,
                    f"vllm {action.kind} post-condition failed: pip exited 0 for "
                    f"{spec!r}, but {VLLM_VENV_PATH} imports version {observed!r} "
                    f"rather than the declared {target!r}.",
                ),
            )
        return code, _append(out, f"imported version {observed} from {VLLM_VENV_PATH}"), err

    return _timed(run)


def _vllm_remove(_action: Action) -> ExecutorResult:
    """Delete the managed venv. vLLM has no separate service to stop, and
    no equivalent of Ollama's model directory to preserve here — the
    Hugging Face cache lives outside the managed venv and is untouched."""

    def run() -> tuple[int, str, str]:
        return _run(["rm", "-rf", VLLM_VENV_PATH], timeout=REMOVE_TIMEOUT_SECONDS)

    return _timed(run)


VLLM_EXECUTORS: dict[str, Callable[[Action], ExecutorResult]] = {
    "install_runtime": _vllm_install_or_upgrade,
    "upgrade_runtime": _vllm_install_or_upgrade,
    "remove_runtime": _vllm_remove,
}
