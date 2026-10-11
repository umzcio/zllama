"""Agent configuration, loaded from /etc/zllama/agent.yaml."""

import re
import socket
from dataclasses import dataclass, field

import yaml

KNOWN_KEYS = {
    "server",
    "node_name",
    "token",
    "interval",
    "converge",
    "log_level",
    "vllm_model_paths",
}

_INTERVAL = re.compile(r"^(\d+)([smh]?)$")
_UNIT_SECONDS = {"": 1, "s": 1, "m": 60, "h": 3600}


@dataclass(frozen=True)
class AgentConfig:
    server: str
    node_name: str
    token: str
    interval_seconds: int
    converge: bool
    log_level: str
    # Defaulted so existing call sites and tests that construct an
    # AgentConfig directly (without opting into scan paths) don't all need
    # updating; `load_config` always passes this explicitly.
    vllm_model_paths: list[str] = field(default_factory=list)


def parse_interval(value) -> int:
    match = _INTERVAL.match(str(value).strip())
    if not match:
        raise ValueError(f"interval must look like 30s, 2m or 1h; got {value!r}")
    amount, unit = match.groups()
    return int(amount) * _UNIT_SECONDS[unit]


def _parse_vllm_model_paths(value) -> list[str]:
    """Validates the optional `vllm_model_paths` list.

    Absent entirely, this defaults to `[]` — vLLM's HF-cache scan alone.
    Present, it must be a YAML list; anything else (a bare string, a
    mapping, a number) is an operator mistake worth failing loudly on at
    load time rather than silently coercing, since a typo'd scalar here
    would otherwise scan a single-character path or similar nonsense.
    Each entry is coerced to `str` so a YAML value that parsed as a
    non-string scalar (e.g. an unquoted path that looks numeric) still
    works as a path.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(
            f"vllm_model_paths must be a list of paths; got {type(value).__name__}"
        )
    return [str(item) for item in value]


def _default_node_name() -> str:
    """Short hostname: everything before the first dot.

    `socket.gethostname()` returns whatever each host happens to have
    configured — some report a bare name (`gpu-node-1`), others an FQDN
    (`gpu-node-4.inference.example.internal`). Normalizing the *derived*
    default keeps the fleet list showing one name shape per host class; an
    explicit `node_name` in the config is never touched by this.
    """
    return socket.gethostname().split(".", 1)[0]


def load_config(path: str) -> AgentConfig:
    with open(path, encoding="utf-8") as handle:
        raw = yaml.safe_load(handle) or {}

    unknown = set(raw) - KNOWN_KEYS
    if unknown:
        raise ValueError(f"unknown config keys: {', '.join(sorted(unknown))}")

    for required in ("server", "token"):
        if not raw.get(required):
            raise ValueError(f"{required} is required in {path}")

    return AgentConfig(
        server=str(raw["server"]).rstrip("/"),
        node_name=str(raw["node_name"]) if raw.get("node_name") else _default_node_name(),
        token=str(raw["token"]),
        interval_seconds=parse_interval(raw.get("interval", "30s")),
        converge=bool(raw.get("converge", False)),
        log_level=str(raw.get("log_level", "info")),
        vllm_model_paths=_parse_vllm_model_paths(raw.get("vllm_model_paths")),
    )
