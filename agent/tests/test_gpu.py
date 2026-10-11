"""Tests for GPU fact collection across reporting behaviours."""

import pathlib
from unittest.mock import MagicMock, patch

import pytest

from zllama_agent.gpu import collect_gpus

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def fixture(name):
    return (FIXTURES / name).read_text()


@pytest.fixture(autouse=True)
def nvidia_smi_present():
    # collect_gpus() bails out early when nvidia-smi is not on PATH, so pretend it
    # is; subprocess.run is mocked per test. The no-binary test overrides this.
    with patch("shutil.which", return_value="/usr/bin/nvidia-smi"):
        yield


def run_result(stdout="", returncode=0, stderr=""):
    result = MagicMock()
    result.stdout = stdout
    result.stderr = stderr
    result.returncode = returncode
    return result


def test_discrete_gpus_use_nvml_memory():
    with patch("subprocess.run", return_value=run_result(fixture("nvidia-discrete.txt"))):
        gpus = collect_gpus()

    assert len(gpus) == 2
    assert gpus[0]["memory_source"] == "nvml"
    assert gpus[0]["memory_total_bytes"] == 97887 * 1024 * 1024
    assert gpus[0]["memory_used_bytes"] == 8431 * 1024 * 1024
    assert gpus[0]["driver_version"] == "595.84"
    assert gpus[0]["driver_status"] == "ok"
    assert gpus[1]["index"] == 1


def test_unified_memory_falls_back_to_meminfo():
    with patch("subprocess.run", return_value=run_result(fixture("nvidia-gb10.txt"))), patch(
        "zllama_agent.gpu._read_meminfo", return_value=fixture("meminfo-gb10.txt")
    ):
        gpus = collect_gpus()

    assert len(gpus) == 1
    assert gpus[0]["name"] == "NVIDIA GB10"
    assert gpus[0]["memory_source"] == "unified"
    # MemTotal 127600748 kB
    assert gpus[0]["memory_total_bytes"] == 127600748 * 1024
    # used = MemTotal - MemAvailable
    assert gpus[0]["memory_used_bytes"] == (127600748 - 10878464) * 1024
    assert gpus[0]["driver_status"] == "ok"


def test_unified_memory_still_reports_util_temp_power():
    with patch("subprocess.run", return_value=run_result(fixture("nvidia-gb10.txt"))), patch(
        "zllama_agent.gpu._read_meminfo", return_value=fixture("meminfo-gb10.txt")
    ):
        gpus = collect_gpus()

    assert gpus[0]["util_pct"] == 0.0
    assert gpus[0]["temp_c"] == 47.0
    assert gpus[0]["power_w"] == 11.37


def test_failed_driver_reports_degraded_not_crash():
    with patch(
        "subprocess.run",
        return_value=run_result(stdout="", stderr=fixture("nvidia-failed.txt"), returncode=9),
    ):
        gpus = collect_gpus()

    assert gpus == []


def test_no_nvidia_smi_binary_returns_empty():
    with patch("shutil.which", return_value=None):
        assert collect_gpus() == []
