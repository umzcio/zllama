"""Report host, GPU, and runtime facts to zllama on an interval.

Read-only: this module only ever reports what it observes. It never installs,
upgrades, or converges anything on the host — that is a later plan.
"""

import json
import logging
import urllib.request

from zllama_agent import __version__
from zllama_agent.config import AgentConfig
from zllama_agent.facts import collect_host, collect_runtimes
from zllama_agent.gpu import collect_gpus

logger = logging.getLogger(__name__)

# A black-holed connection (dropped packets, no RST) would otherwise block the
# agent's check-in loop forever. urlopen has no default timeout, so it must be
# passed explicitly for a failed check-in to stay a failed check-in rather than
# take the agent down.
CHECKIN_TIMEOUT_SECONDS = 10


def build_payload(config: AgentConfig, convergence: dict | None = None) -> dict:
    """Build the check-in payload consumed by zllama's /api/agent/checkin.

    The token never appears in the payload — it is sent only as the bearer
    credential in the Authorization header, never in the request body.

    `convergence`, when given, is the prior cycle's convergence report (see
    `zllama_agent.main._serialize_result`); it is optional and omitted
    entirely rather than sent as an empty/null placeholder when there is
    nothing yet to report.
    """
    payload = {
        "node_name": config.node_name,
        "agent_version": __version__,
        "host": collect_host(),
        "gpus": collect_gpus(),
        "runtimes": collect_runtimes(config.vllm_model_paths),
    }
    if convergence is not None:
        payload["convergence"] = convergence
    return payload


def check_in(config: AgentConfig, convergence: dict | None = None) -> dict:
    """POST a check-in payload to zllama and return the parsed JSON response.

    Raises on a network error or a non-2xx response, so the caller can log
    the failure and retry on the next interval rather than have it swallowed
    here.
    """
    payload = build_payload(config, convergence=convergence)
    body = json.dumps(payload).encode("utf-8")

    request = urllib.request.Request(
        f"{config.server}/api/agent/checkin",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.token}",
        },
    )

    with urllib.request.urlopen(request, timeout=CHECKIN_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))
