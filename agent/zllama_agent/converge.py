"""Runtime convergence: planning, veto, dry-run, serialization.

This module never runs a command itself. It only ever *decides* what should
happen (`plan_actions`) and *orchestrates* injected executors (`converge`) —
the executors that actually shell out live in `executors.py` and are wired
in by the caller (`main.py` for real runs, fakes in tests). That separation
is deliberate: a test can prove every safety property here (veto, dry-run,
locking, closed action vocabulary) without ever touching a real installer.

Versions are opaque strings throughout — never parsed as semver.
"""

from __future__ import annotations

import fcntl
import logging
import time
from dataclasses import dataclass, field
from typing import Callable

from zllama_agent.backoff import BackoffState
from zllama_agent.config import AgentConfig

logger = logging.getLogger(__name__)

# Advisory lock serializing convergence on this host. A non-blocking attempt
# to acquire it lets a second, overlapping cycle report "busy" and execute
# nothing rather than stack two installers on top of each other.
LOCK_PATH = "/var/lock/zllama-agent.converge"

# Where the failure-backoff memory lives. Under /var/lib (not /var/run or
# /tmp) because it has to survive a reboot and, more importantly, the
# systemd restart that follows an agent crash — in-memory state would
# silently defeat the whole feature exactly when it matters. Overridden
# in tests by monkeypatching this name, the same way LOCK_PATH is.
BACKOFF_STATE_PATH = "/var/lib/zllama-agent/backoff.json"

KNOWN_RUNTIME_KINDS = frozenset({"ollama", "vllm"})
KNOWN_PRESENCE_STATES = frozenset({"present", "absent"})

# `plan_actions` only ever produces one of these three runtime kinds;
# `plan_model_actions` (zllama_agent.models) only ever produces one of the
# two model kinds below. ACTION_KINDS is their union — the full closed
# vocabulary — and is what every executor/action-kind check validates
# against.
RUNTIME_ACTION_KINDS = frozenset({"install_runtime", "upgrade_runtime", "remove_runtime"})
MODEL_ACTION_KINDS = frozenset({"pull_model", "remove_model"})

# The action vocabulary is closed by construction: nothing in this module can
# ever produce an Action whose kind is outside this set, and nothing in a
# declaration can name a command, script, or shell string to run.
ACTION_KINDS = RUNTIME_ACTION_KINDS | MODEL_ACTION_KINDS


@dataclass(frozen=True)
class Action:
    """One planned change. `kind` is always one of ACTION_KINDS.

    `model_name` / `model_repo` / `size_bytes` are only ever set for the two
    model action kinds (`pull_model`, `remove_model`) — `model_name` is the
    Ollama tag form, `model_repo` the vLLM/HuggingFace repo-id form; exactly
    one of the two is set, mirroring `ModelDeclaration` on the TypeScript
    side. `size_bytes` is the declared/expected download size used for the
    disk precondition; `None` means unknown and is never assumed to fit.
    """

    kind: str
    runtime: str
    target_version: str | None
    reason: str
    model_name: str | None = None
    model_repo: str | None = None
    size_bytes: int | None = None


@dataclass(frozen=True)
class ExecutorResult:
    """What an executor reports back after attempting one Action.

    `current_action` / `progress_pct` are only ever set by a model-pull
    executor that streamed Ollama's NDJSON pull progress (see
    `models._parse_pull_progress`); every other executor leaves them
    `None`. `progress_pct` is always clamped to 0-100 before it gets here.
    """

    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    current_action: str | None = None
    progress_pct: float | None = None


@dataclass(frozen=True)
class ActionOutcome:
    action: Action
    result: ExecutorResult


@dataclass(frozen=True)
class BlockedAction:
    """A planned `pull_model` action that failed its disk precondition.

    Recorded instead of ever calling an executor — a pull that will not fit
    must not be attempted, and an unknown size is never optimistically
    assumed to fit (see `models.check_disk`).
    """

    action: Action
    shortfall_bytes: int
    reason: str | None


@dataclass(frozen=True)
class BackedOffAction:
    """A planned action skipped because its fingerprint is still cooling down.

    Recorded instead of calling the executor. `next_retry_at` is wall-clock
    epoch seconds (see `backoff.py` for why it is never monotonic), and
    `consecutive_failures` is how many times in a row this fingerprint has
    failed — both are reported to zllama so the console can show *when* the
    next attempt is due rather than just "nothing happened".
    """

    action: Action
    next_retry_at: float
    consecutive_failures: int


@dataclass(frozen=True)
class ConvergenceResult:
    """Outcome of one `converge()` call.

    `status` is one of: "no_changes", "vetoed", "vetoed_remote", "dry_run",
    "busy", "succeeded", "failed", "blocked", "cooling_down". "blocked"
    means at least one planned pull failed its disk precondition; every
    other planned action in the same run still ran to completion (a model
    that won't fit is not a reason to abandon an unrelated runtime action),
    unless one of those other actions itself failed, which takes the
    "failed" status instead. "cooling_down" means every planned action was
    skipped by failure backoff and nothing else ran at all — the host is
    waiting out a previous failure, which is a different (and far less
    alarming) thing than a run that just failed. This vocabulary is closed
    and mirrored exactly by `CONVERGENCE_STATUSES` in
    `app/app/api/agent/checkin/route.ts`, which 400s anything else.
    Never includes the agent's token or any other credential — it carries
    only actions and executor output.
    """

    status: str
    actions: list[Action] = field(default_factory=list)
    outcomes: list[ActionOutcome] = field(default_factory=list)
    blocked: list[BlockedAction] = field(default_factory=list)
    backed_off: list[BackedOffAction] = field(default_factory=list)
    error: str | None = None
    # The most recent progress reported by an executed model pull, carried
    # through to the check-in report (`ConvergenceRun.currentAction` /
    # `.progressPct`). `None` whenever no pull executor reported any (e.g.
    # a runtime-only run, or a run that never got past planning).
    current_action: str | None = None
    progress_pct: float | None = None


Executors = dict[str, dict[str, Callable[[Action], ExecutorResult]]]


def plan_actions(desired: dict, actual: dict) -> list[Action]:
    """Diff a desired declaration against collected facts. Pure; no I/O.

    `desired` is the `Declaration`-shaped dict from a check-in response
    (`{"runtimes": {"ollama": {"state", "version", "models"}, ...}}`).
    `actual` maps a runtime kind already installed on this host to a dict
    with at least a `version` key; a runtime absent from `actual` is treated
    as not installed.

    Raises `ValueError` for a runtime kind or presence state this agent does
    not understand — an unrecognized declaration must never be treated as
    "nothing to do".
    """
    actions: list[Action] = []
    runtimes = desired.get("runtimes") or {}

    for kind, declaration in runtimes.items():
        if kind not in KNOWN_RUNTIME_KINDS:
            raise ValueError(
                f"unknown runtime kind in desired state: {kind!r} "
                f"(expected one of {sorted(KNOWN_RUNTIME_KINDS)})"
            )

        state = declaration.get("state")
        if state not in KNOWN_PRESENCE_STATES:
            raise ValueError(
                f"unknown state {state!r} for runtime {kind!r} "
                f"(expected one of {sorted(KNOWN_PRESENCE_STATES)})"
            )

        target_version = declaration.get("version")
        installed = actual.get(kind)
        installed_version = installed.get("version") if installed else None

        if state == "present":
            if installed is None:
                actions.append(
                    Action(
                        kind="install_runtime",
                        runtime=kind,
                        target_version=target_version,
                        reason=f"{kind} is declared present but not installed",
                    )
                )
            elif target_version is not None and installed_version != target_version:
                actions.append(
                    Action(
                        kind="upgrade_runtime",
                        runtime=kind,
                        target_version=target_version,
                        reason=(
                            f"{kind} installed version {installed_version!r} "
                            f"does not match declared version {target_version!r}"
                        ),
                    )
                )
            # else: already present, and either no version was declared or
            # the installed version already matches it. Nothing to do.
        else:  # state == "absent"
            if installed is not None:
                actions.append(
                    Action(
                        kind="remove_runtime",
                        runtime=kind,
                        target_version=None,
                        reason=f"{kind} is declared absent but is installed",
                    )
                )

    return actions


def converge(
    config: AgentConfig,
    desired: dict,
    actual: dict,
    executors: Executors,
    dry_run: bool,
    remote_converge: bool | None,
    backoff: BackoffState | None = None,
    clock: Callable[[], float] | None = None,
) -> ConvergenceResult:
    """Plan, then (maybe) apply changes to converge this host toward `desired`.

    `dry_run` has no default: the caller must decide explicitly every time.
    `main.py` passes `dry_run=True` unless an operator has deliberately
    opted a host in by writing the `converged-once` state file.

    `remote_converge` is zllama's own last-known opinion (the `converge`
    field of a check-in response), threaded in by the caller — this function
    never reaches out and reads anything itself, it stays pure of I/O.
    `None` means the server didn't say (e.g. the key was absent, or the host
    isn't approved), and is treated exactly like `False`: fail closed. A
    server that did not say yes has not said yes.

    Both the local config and the remote opinion are independent vetoes;
    neither can override the other. Order of checks matters:
      1. No planned actions -> "no_changes", regardless of either veto or
         dry-run.
      2. `config.converge is False` -> "vetoed". The agent's own config is
         its absolute local veto and always wins the label when both sides
         disagree or both refuse.
      3. `remote_converge` is not `True` (i.e. `False` or `None`/missing) ->
         "vetoed_remote". The local config allowed it, but zllama's
         last-known opinion did not.
      4. `dry_run` -> "dry_run".
      5. Otherwise, acquire the per-host lock and execute in order, skipping
         any action still cooling down from an earlier failure and stopping
         at the first failure.

    `backoff` is the failure memory that keeps a failed action from being
    retried every 30-second cycle forever; `None` means "read it from
    `BACKOFF_STATE_PATH`", which is what the real agent does — a fresh read
    per cycle is also what makes the memory survive the systemd restart that
    follows an agent crash. `clock` returns wall-clock epoch seconds and
    defaults to `time.time`; it is a *callable*, not a fixed timestamp,
    because an executor can run for its full ten-minute timeout, and a
    failed action's cooldown has to start when it actually failed rather
    than when the run began. Never `time.monotonic` — see `backoff.py`.
    Neither is consulted before execution: planning, both vetoes and dry-run
    are entirely unaffected by backoff, so an operator always sees the true
    plan.

    Never runs a command itself — executors are injected.
    """
    # Imported here, not at module level, so this module and `models.py`
    # can each import the other's names without a circular-import failure
    # at load time.
    from zllama_agent.models import plan_model_actions

    actions = plan_actions(desired, actual) + plan_model_actions(desired, actual)

    if not actions:
        return ConvergenceResult(status="no_changes", actions=[])

    if not config.converge:
        logger.info("convergence vetoed by local config: %d planned action(s)", len(actions))
        return ConvergenceResult(status="vetoed", actions=actions)

    if not remote_converge:
        logger.info(
            "convergence vetoed by zllama's last-known opinion (converge=%r): "
            "%d planned action(s)",
            remote_converge,
            len(actions),
        )
        return ConvergenceResult(status="vetoed_remote", actions=actions)

    if dry_run:
        logger.info("dry-run: %d planned action(s), executing nothing", len(actions))
        return ConvergenceResult(status="dry_run", actions=actions)

    try:
        lock_file = open(LOCK_PATH, "w", encoding="utf-8")  # noqa: SIM115
    except OSError:
        logger.exception("could not open convergence lock file %s", LOCK_PATH)
        raise

    try:
        try:
            fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            logger.warning("convergence already in progress on this host; skipping cycle")
            return ConvergenceResult(status="busy", actions=actions)

        try:
            state = BackoffState.load(BACKOFF_STATE_PATH) if backoff is None else backoff
            return _execute(
                actions,
                executors,
                state,
                time.time if clock is None else clock,
            )
        finally:
            fcntl.flock(lock_file, fcntl.LOCK_UN)
    finally:
        lock_file.close()


def _execute(
    actions: list[Action],
    executors: Executors,
    backoff: BackoffState,
    clock: Callable[[], float],
) -> ConvergenceResult:
    # Imported here for the same circular-import reason as in `converge()`.
    from zllama_agent.models import MODEL_PATH_BY_RUNTIME, check_disk

    # An entry for a fingerprint this plan no longer names is dead weight:
    # the operator changed the declaration (which is itself the documented
    # way to force an immediate retry), or the action finally converged.
    backoff.prune(actions)

    outcomes: list[ActionOutcome] = []
    blocked: list[BlockedAction] = []
    backed_off: list[BackedOffAction] = []
    # The agent runs one action to completion before starting the next, so
    # "current" is simply the most recent executor result that reported
    # any progress at all — overwritten as later actions run.
    current_action: str | None = None
    progress_pct: float | None = None

    for action in actions:
        # Checked before the disk precondition and before any executor
        # lookup: a cooling-down action must cost nothing at all this
        # cycle. `continue`, never `break` — one action waiting out a
        # failure must not shield the rest of the plan from running.
        cooling = backoff.cooling_down(action, clock())
        if cooling is not None:
            logger.info(
                "%s %s is cooling down after %d consecutive failure(s); "
                "next attempt at %.0f",
                action.kind,
                action.runtime,
                cooling.consecutive_failures,
                cooling.next_retry_at,
            )
            backed_off.append(
                BackedOffAction(
                    action=action,
                    next_retry_at=cooling.next_retry_at,
                    consecutive_failures=cooling.consecutive_failures,
                )
            )
            continue

        if action.kind == "pull_model":
            path = MODEL_PATH_BY_RUNTIME.get(action.runtime)
            verdict = check_disk(action.size_bytes, path)
            if not verdict.ok:
                logger.warning(
                    "blocking pull of %s on %s: %s",
                    action.model_name or action.model_repo,
                    action.runtime,
                    verdict.reason,
                )
                blocked.append(
                    BlockedAction(
                        action=action,
                        shortfall_bytes=verdict.shortfall_bytes,
                        reason=verdict.reason,
                    )
                )
                continue

        runtime_executors = executors.get(action.runtime, {})
        executor = runtime_executors.get(action.kind)
        if executor is None:
            raise ValueError(
                f"no executor registered for runtime {action.runtime!r} "
                f"action {action.kind!r}"
            )

        start = time.monotonic()
        result = executor(action)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        logger.info(
            "%s %s -> exit %s (%d ms)",
            action.kind,
            action.runtime,
            result.exit_code,
            elapsed_ms,
        )
        outcomes.append(ActionOutcome(action=action, result=result))

        if result.current_action is not None or result.progress_pct is not None:
            current_action = result.current_action
            progress_pct = result.progress_pct

        if result.exit_code != 0:
            # The one place a backoff entry is ever created: an executor
            # actually ran and reported failure (a timeout arrives as exit
            # 124, so it is this same branch). The clock is read *here*,
            # after the executor returned, so a ten-minute hang's cooldown
            # starts when it actually failed rather than ten minutes
            # earlier when the run began — and the entry is written before
            # returning, so it survives whatever happens next.
            backoff.record_failure(action, clock())
            backoff.flush()
            return ConvergenceResult(
                status="failed",
                actions=actions,
                outcomes=outcomes,
                blocked=blocked,
                backed_off=backed_off,
                error=(
                    f"{action.kind} for {action.runtime} exited "
                    f"{result.exit_code}: {result.stderr.strip()}"
                ),
                current_action=current_action,
                progress_pct=progress_pct,
            )

        # A success clears the fingerprint outright, so the next failure
        # starts the escalation over at 60s rather than resuming wherever an
        # unrelated earlier failure left off.
        backoff.record_success(action)

    backoff.flush()

    if blocked:
        return ConvergenceResult(
            status="blocked",
            actions=actions,
            outcomes=outcomes,
            blocked=blocked,
            backed_off=backed_off,
            error=f"{len(blocked)} model pull(s) blocked by insufficient disk space",
            current_action=current_action,
            progress_pct=progress_pct,
        )

    # Every planned action was skipped and nothing else happened: the host
    # is waiting out an earlier failure, which is a materially different
    # report from "this run failed" and gets its own closed status.
    if backed_off and not outcomes:
        return ConvergenceResult(
            status="cooling_down",
            actions=actions,
            backed_off=backed_off,
            error=(
                f"{len(backed_off)} action(s) waiting out an earlier failure; "
                "next attempt at "
                f"{min(entry.next_retry_at for entry in backed_off):.0f}"
            ),
        )

    return ConvergenceResult(
        status="succeeded",
        actions=actions,
        outcomes=outcomes,
        backed_off=backed_off,
        current_action=current_action,
        progress_pct=progress_pct,
    )
