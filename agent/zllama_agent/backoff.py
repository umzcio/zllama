"""Failure backoff: remember which convergence actions just failed, and for
how long they must be left alone.

Without this, a convergence action whose executor failed — say an installer
that hung and was killed at its 10-minute timeout — is re-planned and
re-attempted on every 30-second cycle, forever. One bad declaration becomes
a permanent installer loop against a production host. This module is the
memory that turns "it failed" into "don't touch it again until T".

Design notes, each of which is load-bearing:

  - **Executor failures only.** An entry is created exclusively by
    `record_failure`, which `converge._execute` calls only when an executor
    actually ran and reported a non-zero exit code (a timeout arrives here
    as exit 124, so it is the same case). Disk-blocked pulls, vetoes,
    dry-runs and planning errors never reach it: they cost nothing, change
    nothing, and self-heal.

  - **Wall-clock, not monotonic.** `time.monotonic()` restarts at an
    arbitrary origin in every new process, and systemd restarts this agent
    on failure — a monotonic deadline persisted to disk would be
    meaningless (usually already in the past) after exactly the restart
    this feature has to survive. Every timestamp here is `time.time()`
    epoch seconds, injected by the caller so tests never sleep.

  - **Never gives up.** The delay is capped, not terminal: at the cap the
    action is retried hourly forever and keeps showing as failing in the
    UI. An agent that silently stopped trying would be a worse failure mode
    than the loop it replaces.

  - **Bookkeeping never breaks convergence.** A corrupt, unreadable or
    unwritable state file logs a warning and degrades to "no backoff
    remembered". Losing the memory costs one extra retry; raising here
    would take down fact collection and convergence for a host.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:  # pragma: no cover - import cycle avoidance, types only
    from zllama_agent.converge import Action

logger = logging.getLogger(__name__)

# First failure waits a minute, then x4 per consecutive failure
# (60s -> 4m -> 16m -> 64m), clamped to an hour. The clamp is a ceiling on
# the wait, never a give-up: a fingerprint stuck at the cap is retried
# hourly indefinitely.
FIRST_DELAY_SECONDS = 60
DELAY_MULTIPLIER = 4
MAX_DELAY_SECONDS = 3600

# On-disk schema marker. A file written by a future agent with a shape this
# one doesn't understand is discarded (warning, empty start) rather than
# misread — the cost of being wrong here is an unwanted retry loop.
STATE_VERSION = 1

# Written next to the real file and `os.replace`d over it, so a crash or a
# full disk mid-write leaves the previous good state intact rather than a
# half-written JSON document that the next load would have to discard.
TEMP_SUFFIX = ".tmp"

# NUL cannot occur in a runtime kind, a version string, or a model
# name/repo, so it can join the fingerprint parts without ambiguity.
_SEPARATOR = "\u0000"


def fingerprint(action: "Action") -> str:
    """Identity of an action for backoff purposes.

    `(kind, runtime, target_version or "", model name/repo or "")`. Anything
    the operator can change in a declaration — a different target version, a
    different model — produces a *different* fingerprint and therefore a
    fresh, immediate attempt. That is the intended escape hatch: "I changed
    something, try again now" needs no agent-side command at all.
    """
    model = action.model_name or action.model_repo or ""
    return _SEPARATOR.join(
        (action.kind, action.runtime, action.target_version or "", model)
    )


def delay_for(consecutive_failures: int) -> int:
    """Seconds to wait after the n-th consecutive failure: 60, 240, 960, 3600, 3600..."""
    if consecutive_failures < 1:
        return 0
    delay = FIRST_DELAY_SECONDS * (DELAY_MULTIPLIER ** (consecutive_failures - 1))
    return min(delay, MAX_DELAY_SECONDS)


@dataclass
class BackoffEntry:
    """One fingerprint's failure memory."""

    consecutive_failures: int
    next_retry_at: float


class BackoffState:
    """The set of currently-cooling-down action fingerprints, backed by a file.

    Constructed empty; use `load()` to read an existing file (which never
    raises) and `save()` to write one (which never raises either).
    """

    def __init__(self, path: str, entries: dict[str, BackoffEntry] | None = None):
        self.path = path
        self.entries: dict[str, BackoffEntry] = entries or {}
        # Set by any mutation that actually changed something. `flush()`
        # writes only when it is set, so the overwhelmingly common cycle —
        # nothing failed, nothing was remembered — does no disk I/O at all
        # rather than rewriting an empty document every 30 seconds.
        self.dirty = False

    # --- persistence ------------------------------------------------------

    @classmethod
    def load(cls, path: str) -> "BackoffState":
        """Read `path`, or start empty if it is missing, corrupt or unreadable.

        A missing file is the normal first-run case and is not worth a
        warning. Anything else — malformed JSON, a truncated write, a
        directory where the file should be, wrong permissions — logs a
        warning and yields an empty state. Never raises: the caller is in
        the middle of a convergence cycle.
        """
        try:
            with open(path, encoding="utf-8") as handle:
                raw = json.load(handle)
        except FileNotFoundError:
            return cls(path)
        except (OSError, ValueError):
            logger.warning(
                "could not read backoff state %s; starting with no backoff memory "
                "(a failing action may be retried once more than intended)",
                path,
                exc_info=True,
            )
            return cls(path)

        return cls(path, cls._parse_entries(raw, path))

    @staticmethod
    def _parse_entries(raw: object, path: str) -> dict[str, BackoffEntry]:
        if not isinstance(raw, dict) or raw.get("version") != STATE_VERSION:
            logger.warning(
                "backoff state %s is not a version %d document; ignoring it",
                path,
                STATE_VERSION,
            )
            return {}

        raw_entries = raw.get("entries")
        if not isinstance(raw_entries, dict):
            logger.warning("backoff state %s has no usable entries map; ignoring it", path)
            return {}

        entries: dict[str, BackoffEntry] = {}
        for key, value in raw_entries.items():
            if not isinstance(key, str) or not isinstance(value, dict):
                continue
            failures = value.get("consecutive_failures")
            next_retry_at = value.get("next_retry_at")
            # A malformed individual entry is dropped, not fatal: forgetting
            # one fingerprint costs one extra attempt, whereas discarding the
            # whole file would forget every other cooling-down action too.
            if not isinstance(failures, int) or isinstance(failures, bool) or failures < 1:
                continue
            if not isinstance(next_retry_at, (int, float)) or isinstance(next_retry_at, bool):
                continue
            entries[key] = BackoffEntry(
                consecutive_failures=failures,
                next_retry_at=float(next_retry_at),
            )
        return entries

    def save(self) -> None:
        """Persist atomically: write `<path>.tmp`, then `os.replace` it over `path`.

        `os.replace` is atomic within a filesystem, so a reader (or the next
        agent start after a crash) sees either the whole previous document
        or the whole new one — never a truncated file. Failure to write is
        logged, never raised.
        """
        document = {
            "version": STATE_VERSION,
            "entries": {
                key: {
                    "consecutive_failures": entry.consecutive_failures,
                    "next_retry_at": entry.next_retry_at,
                }
                for key, entry in self.entries.items()
            },
        }

        temp_path = self.path + TEMP_SUFFIX
        try:
            parent = os.path.dirname(self.path)
            if parent:
                os.makedirs(parent, exist_ok=True)
            with open(temp_path, "w", encoding="utf-8") as handle:
                json.dump(document, handle)
            os.replace(temp_path, self.path)
            self.dirty = False
        except OSError:
            logger.warning(
                "could not write backoff state %s; this cycle's failures will not be "
                "remembered across a restart",
                self.path,
                exc_info=True,
            )
            try:
                os.remove(temp_path)
            except OSError:
                pass

    def flush(self) -> None:
        """Save, but only if a mutation actually changed something."""
        if self.dirty:
            self.save()

    # --- queries and updates ---------------------------------------------

    def cooling_down(self, action: "Action", now: float) -> BackoffEntry | None:
        """The entry blocking this action right now, or `None` if it may run.

        The deadline is **exclusive**: an action becomes eligible on the
        first cycle strictly *after* its cooldown has elapsed, not the one
        that lands exactly on it. That matters because the delays are exact
        multiples of the default 30s cycle (60s = two cycles), so a cycle
        hits the boundary precisely rather than approximately. Rounding
        toward waiting one more cycle is the conservative direction: 30
        extra seconds of patience costs nothing, while a retry that fires a
        cycle early is the exact failure mode this module exists to prevent.
        """
        entry = self.entries.get(fingerprint(action))
        if entry is None:
            return None
        if now > entry.next_retry_at:
            return None
        return entry

    def record_failure(self, action: "Action", now: float) -> BackoffEntry:
        """Count one more consecutive failure and push the next attempt out."""
        key = fingerprint(action)
        previous = self.entries.get(key)
        failures = (previous.consecutive_failures if previous else 0) + 1
        delay = delay_for(failures)
        entry = BackoffEntry(consecutive_failures=failures, next_retry_at=now + delay)
        self.entries[key] = entry
        self.dirty = True
        logger.warning(
            "%s %s failed (%d consecutive); backing off %ds before the next attempt",
            action.kind,
            action.runtime,
            failures,
            delay,
        )
        return entry

    def record_success(self, action: "Action") -> None:
        """Forget this fingerprint: a success resets the escalation to zero."""
        if self.entries.pop(fingerprint(action), None) is not None:
            self.dirty = True

    def prune(self, actions: "list[Action]") -> None:
        """Drop entries for fingerprints nothing in this plan names any more.

        An action that is no longer planned — because the declaration
        changed, or because it finally converged — has no reason to keep
        occupying the state file.
        """
        planned = {fingerprint(action) for action in actions}
        for key in list(self.entries):
            if key not in planned:
                del self.entries[key]
                self.dirty = True
