"""GPU fact collection, including unified-memory detection.

On unified-memory hardware (e.g. NVIDIA GB10), nvidia-smi reports ``[N/A]``
for memory.total/used/free while still reporting utilization, temperature,
power, and driver version correctly. We detect that from the *value*
nvidia-smi returns, never from a GPU name list, which rots the moment a new
unified-memory part ships.
"""

import logging
import shutil
import subprocess

logger = logging.getLogger(__name__)

_QUERY_FIELDS = (
    "index,name,memory.total,memory.used,memory.free,"
    "utilization.gpu,temperature.gpu,power.draw,driver_version"
)

MIB_TO_BYTES = 1024 * 1024
KIB_TO_BYTES = 1024


def _read_meminfo(path: str = "/proc/meminfo") -> str:
    """Read /proc/meminfo. Broken out so tests can patch it directly."""
    with open(path, encoding="utf-8") as handle:
        return handle.read()


def _parse_meminfo(text: str) -> dict[str, int]:
    """Parse MemTotal/MemAvailable (kB) out of /proc/meminfo text."""
    values = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] in ("MemTotal:", "MemAvailable:"):
            values[parts[0].rstrip(":")] = int(parts[1])
    return values


def _unified_memory_bytes() -> tuple[int | None, int | None]:
    """Return (total_bytes, used_bytes) sourced from /proc/meminfo."""
    try:
        values = _parse_meminfo(_read_meminfo())
    except OSError:
        logger.warning("could not read /proc/meminfo for unified-memory fallback")
        return None, None

    total_kb = values.get("MemTotal")
    available_kb = values.get("MemAvailable")
    total_bytes = total_kb * KIB_TO_BYTES if total_kb is not None else None
    used_bytes = (
        (total_kb - available_kb) * KIB_TO_BYTES
        if total_kb is not None and available_kb is not None
        else None
    )
    return total_bytes, used_bytes


def _parse_mib(value: str) -> int | None:
    value = value.strip()
    if value == "[N/A]" or not value:
        return None
    return int(value.split()[0]) * MIB_TO_BYTES


def _parse_float(value: str) -> float | None:
    value = value.strip()
    if value == "[N/A]" or not value:
        return None
    return float(value.split()[0])


def _parse_row(row: str) -> dict:
    fields = [f.strip() for f in row.split(",")]
    index, name, mem_total, mem_used, _mem_free, util, temp, power, driver_version = fields

    if mem_total == "[N/A]" or not mem_total:
        memory_source = "unified"
        memory_total_bytes, memory_used_bytes = _unified_memory_bytes()
    else:
        memory_source = "nvml"
        memory_total_bytes = _parse_mib(mem_total)
        memory_used_bytes = _parse_mib(mem_used)

    return {
        "index": int(index),
        "vendor": "nvidia",
        "name": name,
        "memory_total_bytes": memory_total_bytes,
        "memory_used_bytes": memory_used_bytes,
        "memory_source": memory_source,
        "driver_version": driver_version,
        "util_pct": _parse_float(util),
        "temp_c": _parse_float(temp),
        "power_w": _parse_float(power),
        "driver_status": "ok",
    }


def collect_gpus() -> list[dict]:
    """Collect per-GPU facts via nvidia-smi. Returns [] if unavailable."""
    if shutil.which("nvidia-smi") is None:
        return []

    result = subprocess.run(
        [
            "nvidia-smi",
            f"--query-gpu={_QUERY_FIELDS}",
            "--format=csv,noheader",
        ],
        capture_output=True,
        text=True,
    )

    if result.returncode != 0:
        logger.warning("nvidia-smi failed (exit %s): %s", result.returncode, result.stderr.strip())
        return []

    rows = [line for line in result.stdout.splitlines() if line.strip()]
    return [_parse_row(row) for row in rows]
