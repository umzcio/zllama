"""Agent entrypoint: load config, then check in and converge on an interval.

A failed check-in or a failed convergence attempt is logged and the loop
continues — neither a restarting zllama server nor a bad declaration may
take the agent down. `_run_cycle` is the pure-ish, testable unit one
iteration wraps; `run_forever` is just that plus the sleep.
"""

import argparse
import logging
import os
import time
from dataclasses import asdict

from zllama_agent.checkin import check_in
from zllama_agent.config import AgentConfig, load_config
from zllama_agent.converge import ConvergenceResult, Executors, converge
from zllama_agent.executors import OLLAMA_EXECUTORS, VLLM_EXECUTORS
from zllama_agent.facts import collect_runtimes
from zllama_agent.models import OLLAMA_MODEL_EXECUTORS, VLLM_MODEL_EXECUTORS

DEFAULT_CONFIG_PATH = "/etc/zllama/agent.yaml"

# Writing this file is a deliberate operator action. Its absence means
# "plan only": a freshly enrolled host must never change anything on its
# own, no matter what its assigned role declares.
CONVERGED_ONCE_PATH = "/var/lib/zllama-agent/converged-once"

logger = logging.getLogger(__name__)

# `plan_model_actions` (zllama_agent.models) plans `pull_model`/`remove_model`
# actions alongside `plan_actions`'s runtime actions, and `_execute` looks up
# both kinds in the same per-runtime executor map — so the model executors
# must be merged in here too, or a real run raises "no executor registered"
# the moment any model is declared.
EXECUTORS: Executors = {
    "ollama": {**OLLAMA_EXECUTORS, **OLLAMA_MODEL_EXECUTORS},
    "vllm": {**VLLM_EXECUTORS, **VLLM_MODEL_EXECUTORS},
}


def _is_dry_run(state_path: str = CONVERGED_ONCE_PATH) -> bool:
    return not os.path.exists(state_path)


def _allow_apply(state_path: str = CONVERGED_ONCE_PATH) -> None:
    """Opt this host into applying convergence changes.

    Creates `state_path` (and any missing parent directories) so a fresh
    host — where `/var/lib/zllama-agent/` doesn't exist yet — doesn't need
    an operator to `mkdir` by hand first. Idempotent: calling this when the
    file already exists is a no-op, not an error, so a re-run (e.g. from a
    provisioning script) is safe.

    This is a one-time, local, deliberate operator action — not a mode the
    agent loop toggles on its own. It writes no token and reads none.
    """
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w", encoding="utf-8"):
        pass


def _disallow_apply(state_path: str = CONVERGED_ONCE_PATH) -> None:
    """Opt this host back out of applying convergence changes.

    Removes `state_path` if present. Idempotent: calling this when the file
    is already absent is a no-op, not an error — reversing `--allow-apply`
    must be exactly as easy as opting in, so an operator (or automation)
    can always fail safely toward dry-run.
    """
    try:
        os.remove(state_path)
    except FileNotFoundError:
        pass


def _serialize_result(result: ConvergenceResult) -> dict:
    """Turn a ConvergenceResult into JSON-safe data for the next check-in.

    Carries only the plan and what each executor reported — never the
    agent's token or any other credential.

    `outcomes` is built by walking `result.actions` in order and matching
    each one, by object identity, against `result.outcomes`, then
    `result.blocked`, then `result.backed_off` — not by list position. A
    blocked `pull_model` or an action skipped by failure backoff is
    `continue`d past in `_execute()` without an executor outcome, so a naive
    positional zip would silently misalign every action after the first
    one; matching by identity keeps `outcomes[i]` describing `actions[i]`
    regardless, and simply omits an entry for an action the loop never
    reached (e.g. after an earlier failure stopped it).

    A backed-off entry carries no `exit_code` at all. It never ran, so it
    has no exit status — and reporting `0` would read as "this succeeded",
    which is the opposite of the truth. It carries `outcome: "backed_off"`
    plus the epoch second the next attempt is due and how many consecutive
    failures got it here, which is what the console needs to explain the
    wait to an operator.
    """
    outcome_by_action = {id(outcome.action): outcome for outcome in result.outcomes}
    blocked_by_action = {id(blocked.action): blocked for blocked in result.blocked}
    backed_off_by_action = {id(entry.action): entry for entry in result.backed_off}

    outcomes: list[dict] = []
    for action in result.actions:
        action_dict = asdict(action)

        outcome = outcome_by_action.get(id(action))
        if outcome is not None:
            outcomes.append(
                {
                    "action": action_dict,
                    "exit_code": outcome.result.exit_code,
                    "stdout": outcome.result.stdout,
                    "stderr": outcome.result.stderr,
                    "duration_ms": outcome.result.duration_ms,
                }
            )
            continue

        blocked = blocked_by_action.get(id(action))
        if blocked is not None:
            outcomes.append(
                {
                    "action": action_dict,
                    "exit_code": 1,
                    "stdout": "",
                    "stderr": blocked.reason or "blocked by insufficient disk space",
                    "duration_ms": 0,
                    "blocked": True,
                    "shortfall_bytes": blocked.shortfall_bytes,
                }
            )
            continue

        backed_off = backed_off_by_action.get(id(action))
        if backed_off is not None:
            outcomes.append(
                {
                    "action": action_dict,
                    "outcome": "backed_off",
                    "next_retry_at": backed_off.next_retry_at,
                    "consecutive_failures": backed_off.consecutive_failures,
                    "stdout": "",
                    "stderr": "",
                    "duration_ms": 0,
                }
            )
        # else: never attempted (the loop stopped at an earlier failure).

    return {
        "status": result.status,
        "actions": [asdict(action) for action in result.actions],
        "outcomes": outcomes,
        "current_action": result.current_action,
        "progress_pct": result.progress_pct,
        "error": result.error,
    }


def _run_cycle(config: AgentConfig, pending_report: dict | None) -> dict | None:
    """Check in (reporting the prior cycle's convergence, if any), then plan
    and possibly apply convergence for this cycle. Never raises: a failed
    check-in or a failed convergence attempt is logged and swallowed here so
    the caller's loop keeps running regardless.
    """
    try:
        response = check_in(config, convergence=pending_report)
    except Exception:
        logger.exception("check-in failed; will retry next interval")
        return None

    desired = response.get("desired")
    if desired is None:
        return None

    try:
        actual = {
            runtime["kind"]: runtime
            for runtime in collect_runtimes(config.vllm_model_paths)
        }
        # `response.get("converge")` is `None` when the key is absent (e.g. an
        # unapproved host, or a server that simply omitted it) — passed
        # straight through so `converge()` fails closed on a missing opinion
        # exactly as it does on an explicit `False`.
        result = converge(
            config,
            desired,
            actual,
            EXECUTORS,
            dry_run=_is_dry_run(),
            remote_converge=response.get("converge"),
        )
        return _serialize_result(result)
    except Exception:
        logger.exception("convergence failed; will report and retry next interval")
        return None


def run_forever(config_path: str) -> None:
    config = load_config(config_path)
    logging.basicConfig(level=config.log_level.upper())

    pending_report: dict | None = None
    while True:
        pending_report = _run_cycle(config, pending_report)
        time.sleep(config.interval_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description="zllama fleet agent")
    parser.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="path to agent.yaml")

    # `--allow-apply` / `--disallow-apply` only ever touch local state
    # (CONVERGED_ONCE_PATH) — they take no config, no server, no token, and
    # exit immediately rather than entering the check-in loop. Mutually
    # exclusive: opting in and opting out in the same invocation has no
    # sensible meaning.
    apply_group = parser.add_mutually_exclusive_group()
    apply_group.add_argument(
        "--allow-apply",
        action="store_true",
        help=(
            "Opt this host into applying convergence changes by writing "
            f"{CONVERGED_ONCE_PATH}. A deliberate, local, one-time operator "
            "action; does not start the check-in loop. Idempotent."
        ),
    )
    apply_group.add_argument(
        "--disallow-apply",
        action="store_true",
        help=(
            "Opt this host back out of applying convergence changes by "
            f"removing {CONVERGED_ONCE_PATH}, reverting it to dry-run. "
            "Reverses --allow-apply. Idempotent."
        ),
    )
    args = parser.parse_args()

    if args.allow_apply:
        _allow_apply()
        return
    if args.disallow_apply:
        _disallow_apply()
        return

    run_forever(args.config)


if __name__ == "__main__":
    main()
