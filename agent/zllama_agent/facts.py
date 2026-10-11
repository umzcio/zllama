"""Host and runtime fact collection.

Includes the *installed model* inventory each runtime reports alongside its
version and disk figures. That inventory is what makes model convergence
work at all: `zllama_agent.models.plan_model_actions` diffs the declaration
against it, so an empty or missing list makes every declared model look
uninstalled and gets it re-pulled on every cycle. Collection never raises —
an absent runtime, a stopped daemon, or a missing cache directory never
raises an exception that would take a whole check-in down.

Silence must not mean "nothing installed": `_ollama_models` and
`_vllm_models` return `None`, not `[]`, when the probe itself could not be
completed (connection refused, malformed body, unrecognized shape, missing
or unreadable cache directory). `[]` is reserved for a probe that actually
succeeded and found nothing. `_ollama_runtime`/`_vllm_runtime` in turn omit
the `models` key entirely when the collector returned `None`, so the wire
payload never claims "zero models" when it really means "couldn't tell" —
the check-in route's prune of `HostModel` rows depends on exactly that
distinction.
"""

import json
import logging
import os
import platform
import pwd
import re
import shutil
import subprocess
import urllib.error
import urllib.request

from zllama_agent.models import OLLAMA_API_BASE, VLLM_MODEL_CACHE_ROOT

logger = logging.getLogger(__name__)

KIB_TO_BYTES = 1024

# A read-only inventory probe against Ollama's own loopback daemon. Short,
# because this runs inside the check-in path: a wedged daemon must not stall
# the agent's loop.
OLLAMA_TAGS_TIMEOUT_SECONDS = 5

# Marker files that identify a Hugging Face repo directory in the managed
# vLLM cache. Used to tell a single-segment repo id (``gpt2``) apart from an
# org directory holding ``org/name`` repos, without guessing from depth.
VLLM_REPO_MARKER_FILES = ("config.json", "model_index.json")

# Marker files that identify a directory as *being* a model, used when
# scanning an operator-configured `vllm_model_paths` entry rather than the
# managed HF cache. Broader than `VLLM_REPO_MARKER_FILES`: a directory
# holding raw safetensors weights with no `config.json` (e.g. a manually
# staged checkpoint) still counts as a model here.
VLLM_MODEL_MARKER_FILENAMES = ("config.json", "model_index.json")
VLLM_MODEL_MARKER_SUFFIX = ".safetensors"

_VERSION_RE = re.compile(r"(\d+\.\d+\.\d+)")

# Where a systemd-installed Ollama (`curl https://ollama.com/install.sh`,
# which creates a system-level `ollama` user) actually keeps its models,
# tried when the expanded default/`OLLAMA_MODELS` path doesn't exist. Not a
# guess: it's the installer's own documented default for that install mode.
_OLLAMA_MODEL_PATH_FALLBACKS = ("/usr/share/ollama/.ollama/models",)

# `systemctl show` runs inline in the check-in path, same reasoning as
# `OLLAMA_TAGS_TIMEOUT_SECONDS`: a wedged systemd/dbus must not stall the
# agent's loop.
SYSTEMCTL_SHOW_TIMEOUT_SECONDS = 5


def _read_meminfo(path: str = "/proc/meminfo") -> str:
    """Read /proc/meminfo. Broken out so tests can patch it directly."""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _read_cpuinfo(path: str = "/proc/cpuinfo") -> str:
    """Read /proc/cpuinfo. Broken out so tests can patch it directly."""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _ram_total_bytes() -> int | None:
    try:
        text = _read_meminfo()
    except OSError:
        logger.warning("could not read /proc/meminfo for ram_total_bytes")
        return None
    for line in text.splitlines():
        parts = line.split()
        if parts and parts[0] == "MemTotal:":
            return int(parts[1]) * KIB_TO_BYTES
    return None


def _lscpu_model() -> str | None:
    """Fall back to `lscpu`'s `Model name:` field.

    `/proc/cpuinfo` has no `model name` line on aarch64 (it's an x86-ism), so
    every ARM host — including DGX Spark systems — would otherwise report a
    null `cpu_model`. `lscpu` normalizes across architectures but needs a
    subprocess, so it's only reached when `/proc/cpuinfo` didn't answer.
    """
    if shutil.which("lscpu") is None:
        return None
    try:
        result = subprocess.run(["lscpu"], capture_output=True, text=True)
    except OSError:
        return None
    for line in (result.stdout or "").splitlines():
        if line.strip().startswith("Model name:"):
            return line.split(":", 1)[1].strip()
    return None


def _cpu_model() -> str | None:
    try:
        text = _read_cpuinfo()
    except OSError:
        text = ""
    for line in text.splitlines():
        if line.lower().startswith("model name"):
            return line.split(":", 1)[1].strip()
    return _lscpu_model()


def collect_host() -> dict:
    """Collect static facts about the host this agent runs on."""
    return {
        "arch": platform.machine(),
        "os": platform.system(),
        "kernel": platform.release(),
        "cpu_model": _cpu_model(),
        "cpu_count": os.cpu_count(),
        "ram_total_bytes": _ram_total_bytes(),
    }


def _service_state(unit: str) -> str | None:
    """Return `systemctl is-active <unit>`, or None if no such unit/systemctl."""
    if shutil.which("systemctl") is None:
        return None
    try:
        result = subprocess.run(
            ["systemctl", "is-active", unit], capture_output=True, text=True
        )
    except OSError:
        return None
    state = result.stdout.strip()
    if not state or state == "unknown":
        return None
    return state


def _disk_usage(path: str) -> tuple[int | None, int | None]:
    try:
        usage = shutil.disk_usage(os.path.expanduser(path))
    except OSError:
        return None, None
    return usage.total, usage.free


def _env_with_home() -> dict[str, str]:
    """A copy of the process environment with `HOME` defaulted if unset.

    Root systemd services get no `HOME` at all — `ollama --version` panics
    on exactly that (`envconfig.Models()` reads `$HOME` directly), and any
    other HOME-dependent runtime CLI would fail the same way. Falls back to
    the passwd entry for the effective user, the same source a real login
    shell would use.
    """
    env = dict(os.environ)
    if not env.get("HOME"):
        env["HOME"] = pwd.getpwuid(os.getuid()).pw_dir
    return env


def _ollama_unit_model_path() -> str | None:
    """`OLLAMA_MODELS`, if set in the `ollama` systemd unit's own
    `Environment=` directive.

    A systemd-managed Ollama (e.g. `Environment="OLLAMA_MODELS=/data"` in
    the unit file) sets this only for the process systemd starts — it is
    invisible to `os.environ` in this agent, which runs as a separate
    process. Without this, an operator who configured the model path at
    the unit level (rather than in a shell profile) gets a silently wrong
    `model_path`/disk figures from `_resolve_ollama_model_path`, even
    though the daemon itself is using the right directory.

    Runs `systemctl show ollama -p Environment --value` as an explicit
    argument list (no shell), with a short timeout so a wedged systemd/dbus
    can't stall a check-in. `--value` prints just the environment block as
    a single space-separated `KEY=VALUE ...` line; values are printed
    unquoted, so a value itself containing a space is indistinguishable
    from the start of the next `KEY=VALUE` pair — out of scope here, a path
    with spaces in it won't be parsed correctly.

    Returns `None` — logged at debug, never raised — when `systemctl` is
    missing, the unit doesn't exist, the command errors or times out, or
    the variable simply isn't present in the unit's environment.
    """
    if shutil.which("systemctl") is None:
        return None
    try:
        result = subprocess.run(
            ["systemctl", "show", "ollama", "-p", "Environment", "--value"],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_SHOW_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("systemctl show ollama -p Environment failed: %s", exc)
        return None
    if result.returncode != 0:
        return None
    for token in result.stdout.split():
        if token.startswith("OLLAMA_MODELS="):
            return token[len("OLLAMA_MODELS=") :]
    return None


def _resolve_ollama_model_path() -> str:
    """Resolve the on-disk directory Ollama keeps its models in.

    `OLLAMA_MODELS`, when set in the agent's own environment, is expanded
    and used outright — an explicit operator override wins even before
    checking whether it exists. Next comes `OLLAMA_MODELS` as set in the
    `ollama` systemd unit's own environment (`_ollama_unit_model_path`),
    which the agent's own environment can never see — the common case
    where Ollama runs as a systemd service with
    `Environment="OLLAMA_MODELS=..."` in the unit file, invisible to this
    process's environment, so without this step the agent silently fell
    back to a wrong default path (and wrong disk-free figures) even
    though the daemon itself was reading the right directory. Otherwise
    the default `~/.ollama/models` is expanded (falling back to the
    passwd database when `$HOME` is unset, which is exactly what happens
    under a root systemd service) and, only if *that* doesn't exist,
    `_OLLAMA_MODEL_PATH_FALLBACKS` is tried in order.

    Always returns the expanded primary path when nothing on disk matches,
    so a nonexistent literal `~/...` is never handed to `disk_usage` — the
    caller ends up with `None` disk figures instead of a bogus lookup
    against the un-expanded string.
    """
    configured = os.environ.get("OLLAMA_MODELS") or _ollama_unit_model_path()
    primary = os.path.expanduser(configured) if configured else os.path.expanduser(
        "~/.ollama/models"
    )
    if os.path.isdir(primary):
        return primary
    for fallback in _OLLAMA_MODEL_PATH_FALLBACKS:
        if os.path.isdir(fallback):
            return fallback
    return primary


def _http_get_json(url: str, *, timeout: int) -> dict | None:
    """GET `url` and parse a JSON object out of it, or None on any failure.

    Deliberately total: a runtime that isn't listening, a non-2xx status, and
    a malformed body are all "no inventory available", never an exception.
    Nothing about a fact probe justifies failing a whole check-in.
    """
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError) as exc:
        logger.debug("model inventory probe failed for %s: %s", url, exc)
        return None
    if not isinstance(data, dict):
        return None
    return data


def _ollama_models() -> list[dict] | None:
    """Installed Ollama models, read from the local daemon's `/api/tags`.

    Ollama already exposes a loopback HTTP API, so this asks it rather than
    parsing its on-disk manifest layout — the same reason
    `zllama_agent.models` pulls and deletes over that API. Model names are
    reported exactly as Ollama reports them: tags are case-sensitive and are
    never normalized.

    Returns `None` when the probe itself failed — the daemon refused the
    connection, the body wasn't valid JSON, or the parsed body doesn't have
    the `{"models": [...]}` shape this expects. `None` means "could not
    determine", never "nothing installed". Only a response that actually
    parses, with a `models` list, produces a real inventory — which is `[]`
    when that list happens to be empty.
    """
    data = _http_get_json(
        f"{OLLAMA_API_BASE}/api/tags", timeout=OLLAMA_TAGS_TIMEOUT_SECONDS
    )
    if data is None:
        return None

    entries = data.get("models")
    if not isinstance(entries, list):
        return None

    models: list[dict] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        size = entry.get("size")
        digest = entry.get("digest")
        has_size = isinstance(size, int) and not isinstance(size, bool)
        models.append(
            {
                "name": name,
                "size_bytes": size if has_size else None,
                "digest": digest if isinstance(digest, str) and digest else None,
            }
        )
    return models


def _directory_size_bytes(path: str) -> int | None:
    """Total size of the files under `path`, or None if it can't be read.

    Follows no symlinks and counts each entry's own size, so a symlinked
    blob store is never double-counted into a fabricated total.
    """
    total = 0
    seen_any = False
    for root, _dirs, files in os.walk(path, followlinks=False):
        for filename in files:
            try:
                stat = os.lstat(os.path.join(root, filename))
            except OSError:
                continue
            total += stat.st_size
            seen_any = True
    if not seen_any and not os.path.isdir(path):
        return None
    return total


def _is_vllm_repo_dir(path: str) -> bool:
    return any(
        os.path.isfile(os.path.join(path, marker)) for marker in VLLM_REPO_MARKER_FILES
    )


def _list_subdirectories(path: str) -> list[str]:
    try:
        return sorted(
            entry.name
            for entry in os.scandir(path)
            if entry.is_dir(follow_symlinks=False)
        )
    except OSError:
        return []


def _scan_hf_cache(cache_root: str) -> list[dict] | None:
    """Repos present in the managed vLLM cache directory.

    Nothing is installed *into* vLLM — a model is "present" when
    its weights sit in the cache root that `zllama_agent.models._vllm_pull`
    writes to, so the inventory is that directory read back. A repo id is
    normally `org/name`, which is two directory levels; a single-segment id
    is one. The two are told apart by a repo marker file rather than by
    guessing from depth.

    Returns `None` when the cache root itself can't be listed — missing, or
    present but unreadable (permissions) — meaning "could not determine",
    never "nothing installed". A cache root that lists cleanly and simply
    has nothing in it is a real `[]`.
    """
    try:
        top_level = sorted(
            entry.name
            for entry in os.scandir(cache_root)
            if entry.is_dir(follow_symlinks=False)
        )
    except OSError:
        return None

    models: list[dict] = []
    for first in top_level:
        first_path = os.path.join(cache_root, first)
        if _is_vllm_repo_dir(first_path):
            models.append(
                {
                    "name": first,
                    "size_bytes": _directory_size_bytes(first_path),
                    "digest": None,
                }
            )
            continue
        for second in _list_subdirectories(first_path):
            second_path = os.path.join(first_path, second)
            models.append(
                {
                    "name": f"{first}/{second}",
                    "size_bytes": _directory_size_bytes(second_path),
                    "digest": None,
                }
            )
    return models


def _is_vllm_model_marker_dir(path: str) -> bool:
    """Whether `path` itself *is* a model directory, per the marker rule
    used for operator-configured `vllm_model_paths` entries: a
    `config.json`, a `model_index.json`, or any `*.safetensors` file.

    Broader than `_is_vllm_repo_dir` (which only looks at the two named
    files) because a configured path may point at raw weights staged by
    hand, with no HF-style `config.json` alongside them.
    """
    try:
        entries = list(os.scandir(path))
    except OSError:
        return False
    for entry in entries:
        if not entry.is_file(follow_symlinks=False):
            continue
        if entry.name in VLLM_MODEL_MARKER_FILENAMES or entry.name.endswith(
            VLLM_MODEL_MARKER_SUFFIX
        ):
            return True
    return False


def _scan_model_dir(path: str) -> list[dict]:
    """Scans a single configured path for models, per the marker rule.

    If `path` itself is a model directory (has a marker file), it is
    reported as exactly one model named by its own basename, with
    `size_bytes` from the recursive size of everything under it. Otherwise
    its immediate children are scanned the same way — this lets a configured
    path point either straight at one model, or at a directory holding
    several.
    """
    if _is_vllm_model_marker_dir(path):
        return [
            {
                "name": os.path.basename(os.path.normpath(path)),
                "size_bytes": _directory_size_bytes(path),
                "digest": None,
            }
        ]

    models: list[dict] = []
    for child in _list_subdirectories(path):
        models.extend(_scan_model_dir(os.path.join(path, child)))
    return models


def _scan_configured_vllm_path(path: str) -> list[dict]:
    """Scans one operator-configured `vllm_model_paths` entry.

    A missing or unreadable configured path is logged and skipped —
    contributing nothing to the inventory — rather than raising or
    poisoning the rest of the scan. This is deliberately more forgiving
    than the managed HF cache: an operator can list several paths, and one
    bad entry (a typo, an unmounted drive) must not take the others down
    with it.
    """
    if not os.path.isdir(path):
        logger.warning(
            "configured vllm_model_paths entry %r is missing or not a directory; skipping",
            path,
        )
        return []
    return _scan_model_dir(path)


def _vllm_models(
    cache_root: str = VLLM_MODEL_CACHE_ROOT,
    extra_paths: list[str] | None = None,
) -> list[dict] | None:
    """Installed vLLM model inventory: the managed HF cache, plus any
    operator-configured `vllm_model_paths`, deduped by name.

    The `None`-vs-`[]` distinction from the HF-cache scan alone
    (`_scan_hf_cache`) is preserved here, but a configured path that finds
    models is authoritative on its own even when the HF-cache scan failed:
    a `None` cache-scan result only propagates to the combined result when
    the configured-path scan *also* found nothing, so one probe succeeding
    is always enough to produce a real (if partial) inventory. See
    `_scan_configured_vllm_path` for why a single bad configured path never
    taints the rest.
    """
    hf_models = _scan_hf_cache(cache_root)

    configured_models: list[dict] = []
    for path in extra_paths or []:
        configured_models.extend(_scan_configured_vllm_path(path))

    if hf_models is None and not configured_models:
        return None

    combined = list(hf_models) if hf_models is not None else []
    seen_names = {model["name"] for model in combined}
    for model in configured_models:
        if model["name"] in seen_names:
            continue
        combined.append(model)
        seen_names.add(model["name"])
    return combined


def _ollama_runtime() -> dict | None:
    if shutil.which("ollama") is None:
        return None
    try:
        result = subprocess.run(
            ["ollama", "--version"],
            capture_output=True,
            text=True,
            env=_env_with_home(),
        )
        output = result.stdout or result.stderr
    except OSError:
        output = ""

    match = _VERSION_RE.search(output)
    model_path = _resolve_ollama_model_path()
    disk_total_bytes, disk_free_bytes = _disk_usage(model_path)

    runtime = {
        "kind": "ollama",
        "version": match.group(1) if match else None,
        "install_method": "binary",
        "service_state": _service_state("ollama"),
        "model_path": model_path,
        "disk_total_bytes": disk_total_bytes,
        "disk_free_bytes": disk_free_bytes,
    }
    # `None` means the inventory probe failed, not that nothing is
    # installed. Omitting the key entirely — rather than sending `models:
    # null` — matches the wire shape the check-in route already treats as
    # "no information": it only prunes previously-recorded rows when
    # `models` is present.
    models = _ollama_models()
    if models is not None:
        runtime["models"] = models
    return runtime


def _vllm_runtime(vllm_model_paths: list[str] | None = None) -> dict | None:
    """Fact-collect vLLM, including the "external" case.

    An operator can point `vllm_model_paths` at weights that live on this
    host (e.g. bind-mounted into a container) while vLLM itself runs
    somewhere the `vllm` package was never pip-installed — no host-level
    `python3 -m vllm` import will ever succeed there. Before this fix that
    made `collect_runtimes()` return no vllm entry at all, so the
    configured scan never ran and the model was invisible end to end. So:
    a configured `vllm_model_paths` list always produces a runtime entry,
    with `install_method: "external"` and no version/service info when the
    package genuinely isn't host-installed. The prior rule — no entry at
    all when vLLM isn't installed — still holds when no paths are
    configured; only a configured path resurrects the entry.
    """
    vllm_model_paths = vllm_model_paths or []

    try:
        result = subprocess.run(
            ["python3", "-c", "import vllm;print(vllm.__version__)"],
            capture_output=True,
            text=True,
            env=_env_with_home(),
        )
    except OSError:
        result = None

    version = result.stdout.strip() if result is not None else ""
    installed = result is not None and result.returncode == 0 and bool(version)

    if installed:
        model_path = os.environ.get("HF_HOME") or "~/.cache/huggingface"
        disk_total_bytes, disk_free_bytes = _disk_usage(model_path)
        runtime = {
            "kind": "vllm",
            "version": version,
            "install_method": "pip",
            "service_state": _service_state("vllm"),
            "model_path": model_path,
            "disk_total_bytes": disk_total_bytes,
            "disk_free_bytes": disk_free_bytes,
        }
    elif vllm_model_paths:
        model_path = vllm_model_paths[0]
        disk_total_bytes, disk_free_bytes = _disk_usage(model_path)
        runtime = {
            "kind": "vllm",
            "version": None,
            "install_method": "external",
            "service_state": None,
            "model_path": model_path,
            "disk_total_bytes": disk_total_bytes,
            "disk_free_bytes": disk_free_bytes,
        }
    else:
        return None

    # Same rule as the Ollama runtime above: `None` means "could not
    # determine", so the key is omitted rather than sent as `models: []`.
    # The configured-path scan (plus HF cache, if any) runs identically in
    # both branches above — `_vllm_models` already combines the two.
    models = _vllm_models(extra_paths=vllm_model_paths)
    if models is not None:
        runtime["models"] = models
    return runtime


def collect_runtimes(vllm_model_paths: list[str] | None = None) -> list[dict]:
    """Collect facts for each inference runtime found on this host.

    A runtime that isn't installed is simply absent from the list — never a
    placeholder entry with a null version, which would be indistinguishable
    from "installed but version unknown" — *unless* it is vLLM and
    `vllm_model_paths` is non-empty: an operator-configured path means
    weights this host should report on even when the `vllm` package was
    never installed here (see `_vllm_runtime`), so that case gets an
    `install_method: "external"` entry instead of being dropped.

    `vllm_model_paths` is the operator-configured list of extra directories
    to scan for vLLM models (`AgentConfig.vllm_model_paths`), on top of the
    managed HF cache; see `_vllm_models`.
    """
    runtimes = []
    for probe in (_ollama_runtime, lambda: _vllm_runtime(vllm_model_paths)):
        runtime = probe()
        if runtime is not None:
            runtimes.append(runtime)
    return runtimes
