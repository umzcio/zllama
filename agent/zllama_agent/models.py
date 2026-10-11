"""Model convergence: planning pull/remove actions, disk preconditions, and
the Ollama/vLLM model executors.

Mirrors the separation in `converge.py` and `executors.py`: `plan_model_actions`
only ever *decides* what should happen — pure, no I/O, no subprocess. The
model executors are the one place that actually reaches out: Ollama's own
HTTP API for pulling/removing tags (Ollama runs a local daemon that already
exposes one), and `subprocess` for vLLM, which has no equivalent daemon and
manages its Hugging Face cache directly as files on disk.

Safety rules enforced throughout this file:
  - Models are never removed implicitly. `plan_model_actions` only ever
    plans a `remove_model` for a model an operator explicitly declared
    `state: "absent"` by name/repo. A model present on a host but absent
    from the declaration produces no action at all.
  - Disk space is a hard precondition for a pull. `check_disk` treats an
    unknown required size (`None`) as *not* fitting — never optimistically
    assumed to fit.
  - Every model name and repo id is passed as data (a JSON field, or its
    own argv element) — never interpolated into a shell string.
  - vLLM "remove" resolves its target with `os.path.realpath` and refuses
    to delete anything outside the managed cache root. This is the single
    most safety-critical check in this file: vLLM model removal deletes a
    directory as root, and a `../`-laden repo id must not be able to walk
    it outside the cache.
  - Every subprocess call and every HTTP call carries an explicit timeout,
    so a stalled multi-gigabyte download cannot wedge the agent forever.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

from zllama_agent.converge import Action, ExecutorResult

logger = logging.getLogger(__name__)

KNOWN_RUNTIME_KINDS = frozenset({"ollama", "vllm"})
KNOWN_PRESENCE_STATES = frozenset({"present", "absent"})

# Well-known, fixed locations on the managed host — never taken from a
# declaration. `check_disk` reports free space on these; the vLLM executors
# additionally treat `VLLM_MODEL_CACHE_ROOT` as the one directory a
# `remove_model` action is ever allowed to delete inside.
OLLAMA_MODELS_PATH = "/usr/share/ollama/.ollama/models"
VLLM_MODEL_CACHE_ROOT = "/opt/zllama-agent/vllm-model-cache"

MODEL_PATH_BY_RUNTIME: dict[str, str] = {
    "ollama": OLLAMA_MODELS_PATH,
    "vllm": VLLM_MODEL_CACHE_ROOT,
}

# Ollama's own local daemon, reached over loopback HTTP — never a shell.
OLLAMA_API_BASE = "http://localhost:11434"
OLLAMA_API_TIMEOUT_SECONDS = 3600  # a large pull streams for a long time
OLLAMA_DELETE_TIMEOUT_SECONDS = 30

VLLM_PULL_TIMEOUT_SECONDS = 3600  # a 40GB HF repo download can take a while
VLLM_REMOVE_TIMEOUT_SECONDS = 30


# --- Disk precondition ------------------------------------------------------


@dataclass(frozen=True)
class DiskVerdict:
    """Whether a pull of `required_bytes` fits on the runtime's model path."""

    ok: bool
    free_bytes: int
    shortfall_bytes: int
    reason: str | None = None


def check_disk(required_bytes: int | None, path: str) -> DiskVerdict:
    """Checks free space at `path` against `required_bytes`.

    `required_bytes=None` means the size is unknown, and is always treated
    as *not* fitting — never optimistically assumed to fit — so a pull with
    no known size is always blocked until a size becomes known.
    """
    free_bytes = shutil.disk_usage(path).free

    if required_bytes is None:
        return DiskVerdict(
            ok=False,
            free_bytes=free_bytes,
            shortfall_bytes=0,
            reason="model size is unknown; refusing to assume it fits",
        )

    if required_bytes <= free_bytes:
        return DiskVerdict(ok=True, free_bytes=free_bytes, shortfall_bytes=0)

    shortfall_bytes = required_bytes - free_bytes
    return DiskVerdict(
        ok=False,
        free_bytes=free_bytes,
        shortfall_bytes=shortfall_bytes,
        reason=(
            f"requires {required_bytes} bytes, only {free_bytes} free "
            f"(short by {shortfall_bytes} bytes)"
        ),
    )


# --- Planning ----------------------------------------------------------------


def _identifier(model: dict) -> str | None:
    """A declared or actual model's identifier: `name` (Ollama) or `repo`
    (vLLM). Exactly one is expected to be set, mirroring `ModelDeclaration`
    on the TypeScript side."""
    name = model.get("name")
    if name is not None:
        return name
    return model.get("repo")


def plan_model_actions(desired: dict, actual: dict) -> list[Action]:
    """Diff declared models against installed ones. Pure; no I/O.

    Only ever plans an action for a model an operator explicitly declared.
    A model installed but never named in the declaration produces no
    action at all — models are never removed implicitly.

    Raises `ValueError` for a runtime kind this agent does not understand,
    for the same reason `plan_actions` does: an unrecognized declaration
    must never be silently treated as "nothing to do".
    """
    actions: list[Action] = []
    runtimes = desired.get("runtimes") or {}

    for kind, declaration in runtimes.items():
        if kind not in KNOWN_RUNTIME_KINDS:
            raise ValueError(
                f"unknown runtime kind in desired state: {kind!r} "
                f"(expected one of {sorted(KNOWN_RUNTIME_KINDS)})"
            )

        declared_models = declaration.get("models") or []
        installed = actual.get(kind) or {}
        installed_models = installed.get("models") or []
        installed_identifiers = {
            identifier
            for identifier in (_identifier(m) for m in installed_models)
            if identifier is not None
        }

        for model in declared_models:
            identifier = _identifier(model)
            if identifier is None:
                continue

            state = model.get("state", "present")
            if state not in KNOWN_PRESENCE_STATES:
                raise ValueError(
                    f"unknown state {state!r} for model {identifier!r} on runtime {kind!r} "
                    f"(expected one of {sorted(KNOWN_PRESENCE_STATES)})"
                )

            is_installed = identifier in installed_identifiers

            if state == "present":
                if not is_installed:
                    actions.append(
                        Action(
                            kind="pull_model",
                            runtime=kind,
                            target_version=None,
                            reason=f"model {identifier!r} is declared present but not installed",
                            model_name=model.get("name"),
                            model_repo=model.get("repo"),
                            size_bytes=model.get("size_bytes"),
                        )
                    )
                # else: already installed. Nothing to do.
            else:  # state == "absent"
                if is_installed:
                    actions.append(
                        Action(
                            kind="remove_model",
                            runtime=kind,
                            target_version=None,
                            reason=f"model {identifier!r} is declared absent but is installed",
                            model_name=model.get("name"),
                            model_repo=model.get("repo"),
                        )
                    )
            # A model installed but never named in `declared_models` is
            # simply never visited by this loop, so it never generates an
            # action — that is the never-delete-implicitly rule.

    return actions


# --- Shared subprocess/HTTP helpers -----------------------------------------


def _run(args: list[str], *, timeout: int) -> tuple[int, str, str]:
    """The one place vLLM model actions call `subprocess.run`. Always an
    argument list, never `shell=True`, and always with an explicit timeout
    so a stalled download cannot wedge the agent forever."""
    try:
        result = subprocess.run(
            args,
            shell=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout if isinstance(exc.stdout, str) else ""
        stderr = exc.stderr if isinstance(exc.stderr, str) else ""
        stderr += f"\ntimed out after {timeout}s"
        return 124, stdout, stderr


def _timed(fn: Callable[[], tuple[int, str, str]]) -> ExecutorResult:
    start = time.monotonic()
    exit_code, stdout, stderr = fn()
    duration_ms = int((time.monotonic() - start) * 1000)
    return ExecutorResult(
        exit_code=exit_code, stdout=stdout, stderr=stderr, duration_ms=duration_ms
    )


def _http_request(url: str, *, method: str, payload: dict, timeout: int) -> tuple[int, str, str]:
    """The one place Ollama model actions make an HTTP call. `payload` is
    always sent as a JSON body — a tag containing shell metacharacters is
    just a string in that body, never parsed by a shell, because no shell
    is ever invoked."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return 0, response.read().decode("utf-8"), ""
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        return exc.code, "", detail
    except urllib.error.URLError as exc:
        return 1, "", str(exc.reason)


# --- Ollama model executors --------------------------------------------------


@dataclass(frozen=True)
class PullProgress:
    """The last progress reported by an Ollama pull's NDJSON stream."""

    current_action: str | None
    progress_pct: float | None
    error: str | None = None


def _parse_pull_progress(raw_body: str) -> PullProgress:
    """Parses Ollama's streamed `/api/pull` NDJSON response.

    Mirrors `app/lib/pull-manager.ts`'s parsing of the same stream: each
    line is an independent JSON object; a malformed line is skipped rather
    than aborting the pull; a line carrying `error` fails the pull with
    that message; `total`/`completed` produce a percentage clamped to
    0-100 so a server reporting `completed > total` can never yield more
    than 100%.

    Returns the *last* status/percentage seen before either the stream
    ended or an error line appeared — never raises.
    """
    current_action: str | None = None
    progress_pct: float | None = None

    for line in raw_body.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue

        error = data.get("error")
        if error:
            return PullProgress(
                current_action=current_action, progress_pct=progress_pct, error=str(error)
            )

        status = data.get("status")
        if isinstance(status, str):
            current_action = status

        total = data.get("total")
        completed = data.get("completed")
        if (
            isinstance(total, (int, float))
            and not isinstance(total, bool)
            and isinstance(completed, (int, float))
            and not isinstance(completed, bool)
            and total > 0
        ):
            progress_pct = max(0.0, min(100.0, (completed / total) * 100))

    return PullProgress(current_action=current_action, progress_pct=progress_pct)


def _ollama_pull(action: Action) -> ExecutorResult:
    """Calls Ollama's `/api/pull` for the declared tag, streamed, and
    parses the NDJSON progress it reports. The tag is sent as a JSON
    field, never interpolated into a command string."""

    def run() -> tuple[int, str, str]:
        return _http_request(
            f"{OLLAMA_API_BASE}/api/pull",
            method="POST",
            payload={"name": action.model_name, "stream": True},
            timeout=OLLAMA_API_TIMEOUT_SECONDS,
        )

    result = _timed(run)
    progress = _parse_pull_progress(result.stdout)

    if progress.error is not None:
        return ExecutorResult(
            exit_code=1,
            stdout=result.stdout,
            stderr=progress.error,
            duration_ms=result.duration_ms,
            current_action=progress.current_action,
            progress_pct=progress.progress_pct,
        )

    return ExecutorResult(
        exit_code=result.exit_code,
        stdout=result.stdout,
        stderr=result.stderr,
        duration_ms=result.duration_ms,
        current_action=progress.current_action,
        progress_pct=progress.progress_pct,
    )


def _ollama_remove(action: Action) -> ExecutorResult:
    """Calls Ollama's `/api/delete` for exactly the named tag."""

    def run() -> tuple[int, str, str]:
        return _http_request(
            f"{OLLAMA_API_BASE}/api/delete",
            method="DELETE",
            payload={"name": action.model_name},
            timeout=OLLAMA_DELETE_TIMEOUT_SECONDS,
        )

    return _timed(run)


OLLAMA_MODEL_EXECUTORS: dict[str, Callable[[Action], ExecutorResult]] = {
    "pull_model": _ollama_pull,
    "remove_model": _ollama_remove,
}


# --- vLLM model executors -----------------------------------------------------


def _resolve_within_cache_root(repo: str, cache_root: str) -> str | None:
    """Resolves `repo` under `cache_root` and returns the real path only if
    it stays inside the managed cache root; `None` otherwise.

    This is the path-traversal containment check: `repo` is untrusted data
    (an operator-declared string), and vLLM model removal deletes whatever
    this resolves to as root. `os.path.join` alone is not enough — a `repo`
    containing `../../..` walks upward, and an absolute-path `repo` makes
    `os.path.join` discard `cache_root` entirely — so containment is
    verified on the final, symlink-resolved path, never assumed from how it
    was constructed.
    """
    root_real = os.path.realpath(cache_root)
    candidate_real = os.path.realpath(os.path.join(cache_root, repo))

    # Must be a strict subdirectory of the cache root — never the root
    # itself (an empty or malformed repo id must not wipe the whole cache)
    # and never anything `..`, a symlink, or an absolute repo id walks to.
    if candidate_real == root_real or not candidate_real.startswith(root_real + os.sep):
        return None
    return candidate_real


def _vllm_pull(action: Action) -> ExecutorResult:
    """Downloads the declared Hugging Face repo into the managed cache path.

    The repo id is one argv element in an argument list — never a shell
    string — so it can never be parsed as a shell command. It is also
    *contained*: `--local-dir` is resolved with `_resolve_within_cache_root`
    exactly as the remove path is, and the pull is refused outright when it
    would land outside the managed cache root.

    Containment matters just as much here as on remove. The agent runs as
    root under `zllama-agent.service`, `os.path.join` discards the cache root
    entirely for an absolute `repo`, and a `../`-laden one walks upward —
    after which `huggingface-cli download` writes files there as root.
    Guarding one path and not the other left the same untrusted input able
    to write anywhere on the host.
    """
    repo = action.model_repo
    target = (
        _resolve_within_cache_root(repo, VLLM_MODEL_CACHE_ROOT)
        if isinstance(repo, str)
        else None
    )

    if target is None:
        return ExecutorResult(
            exit_code=1,
            stdout="",
            stderr=(
                f"refusing to pull {repo!r}: it resolves outside the managed "
                f"cache root {VLLM_MODEL_CACHE_ROOT!r}"
            ),
            duration_ms=0,
        )

    def run() -> tuple[int, str, str]:
        return _run(
            [
                "huggingface-cli",
                "download",
                repo,
                "--local-dir",
                target,
            ],
            timeout=VLLM_PULL_TIMEOUT_SECONDS,
        )

    return _timed(run)


def _vllm_remove(action: Action) -> ExecutorResult:
    """Deletes a repo's directory from the managed cache — and only from
    inside it. See `_resolve_within_cache_root`: a repo id that would
    resolve outside `VLLM_MODEL_CACHE_ROOT` is rejected before any command
    is issued, never deleted."""
    repo = action.model_repo
    target = _resolve_within_cache_root(repo, VLLM_MODEL_CACHE_ROOT)

    if target is None:
        return ExecutorResult(
            exit_code=1,
            stdout="",
            stderr=(
                f"refusing to remove {repo!r}: it resolves outside the managed "
                f"cache root {VLLM_MODEL_CACHE_ROOT!r}"
            ),
            duration_ms=0,
        )

    def run() -> tuple[int, str, str]:
        return _run(["rm", "-rf", target], timeout=VLLM_REMOVE_TIMEOUT_SECONDS)

    return _timed(run)


VLLM_MODEL_EXECUTORS: dict[str, Callable[[Action], ExecutorResult]] = {
    "pull_model": _vllm_pull,
    "remove_model": _vllm_remove,
}
