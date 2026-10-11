"""Tests for the agent check-in client."""

import json
import urllib.error
from unittest.mock import MagicMock, patch

from zllama_agent import __version__
from zllama_agent.checkin import CHECKIN_TIMEOUT_SECONDS, build_payload, check_in
from zllama_agent.config import AgentConfig

CONFIG = AgentConfig(
    server="https://zllama.example",
    node_name="node-a",
    token="super-secret-token",
    interval_seconds=30,
    converge=False,
    log_level="info",
)

HOST = {
    "arch": "x86_64",
    "os": "Linux",
    "kernel": "6.8.0-generic",
    "cpu_model": "AMD Threadripper",
    "cpu_count": 20,
    "ram_total_bytes": 0,
}

GPUS = [
    {
        "index": 0,
        "vendor": "nvidia",
        "name": "NVIDIA GB10",
        "memory_total_bytes": None,
        "memory_used_bytes": 0,
        "memory_source": "unified",
        "driver_version": "580.65.06",
        "driver_status": "ok",
        "util_pct": 0.0,
        "temp_c": 47.0,
        "power_w": 11.37,
    }
]

RUNTIMES = [
    {
        "kind": "ollama",
        "version": "0.32.13",
        "install_method": "binary",
        "service_state": "active",
        "model_path": "/root/.ollama/models",
        "disk_total_bytes": 0,
        "disk_free_bytes": 0,
    }
]


def test_build_payload_includes_node_facts():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES):
        payload = build_payload(CONFIG)

    assert payload["node_name"] == "node-a"
    assert payload["agent_version"] == __version__
    assert payload["host"] == HOST
    assert payload["gpus"] == GPUS
    assert payload["runtimes"] == RUNTIMES


def test_build_payload_preserves_null_memory_total_bytes():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES):
        payload = build_payload(CONFIG)

    serialized = json.dumps(payload)
    parsed = json.loads(serialized)
    assert parsed["gpus"][0]["memory_total_bytes"] is None
    assert "0" not in serialized.split('"memory_total_bytes":')[1].split(",")[0].strip()


def _mock_response(body: dict) -> MagicMock:
    response = MagicMock()
    response.__enter__.return_value = response
    response.read.return_value = json.dumps(body).encode("utf-8")
    return response


def test_check_in_posts_to_checkin_endpoint_with_bearer_token():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES), patch(
        "urllib.request.urlopen", return_value=_mock_response({"status": "pending"})
    ) as mock_urlopen:
        result = check_in(CONFIG)

    assert result == {"status": "pending"}
    request = mock_urlopen.call_args[0][0]
    assert request.full_url == "https://zllama.example/api/agent/checkin"
    assert request.get_method() == "POST"
    assert request.get_header("Authorization") == "Bearer super-secret-token"


def test_check_in_raises_on_non_2xx_response():
    error = urllib.error.HTTPError(
        url="https://zllama.example/api/agent/checkin",
        code=401,
        msg="Unauthorized",
        hdrs=None,
        fp=None,
    )
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES), patch(
        "urllib.request.urlopen", side_effect=error
    ):
        try:
            check_in(CONFIG)
        except urllib.error.HTTPError as caught:
            assert caught.code == 401
        else:
            raise AssertionError("expected check_in to raise on a 401 response")


def test_check_in_passes_an_explicit_timeout():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES), patch(
        "urllib.request.urlopen", return_value=_mock_response({"status": "pending"})
    ) as mock_urlopen:
        check_in(CONFIG)

    # urlopen has no default timeout: without an explicit one a black-holed
    # connection blocks the agent's loop forever.
    assert mock_urlopen.call_args.kwargs["timeout"] == CHECKIN_TIMEOUT_SECONDS
    assert CHECKIN_TIMEOUT_SECONDS == 10


def test_check_in_never_sends_token_in_body():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES), patch(
        "urllib.request.urlopen", return_value=_mock_response({"status": "pending"})
    ) as mock_urlopen:
        check_in(CONFIG)

    request = mock_urlopen.call_args[0][0]
    assert CONFIG.token not in request.data.decode("utf-8")
    assert request.get_header("Authorization") == f"Bearer {CONFIG.token}"


def test_check_in_propagates_network_error():
    with patch("zllama_agent.checkin.collect_host", return_value=HOST), patch(
        "zllama_agent.checkin.collect_gpus", return_value=GPUS
    ), patch("zllama_agent.checkin.collect_runtimes", return_value=RUNTIMES), patch(
        "urllib.request.urlopen", side_effect=OSError("network unreachable")
    ):
        try:
            check_in(CONFIG)
        except OSError as caught:
            assert "network unreachable" in str(caught)
        else:
            raise AssertionError("expected check_in to propagate the network error")
