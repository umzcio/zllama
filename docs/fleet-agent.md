# Operating the fleet agent

This is the operator's guide to `zllama_agent`: enrolling a host, approving
it, giving it a role, reading its drift, and — the step that actually lets a
host change itself — opting it into applying changes.

**Status: in the original author's deployment, convergence was executed
against real hardware exactly once** — one Ollama version upgrade — and it
found a real defect on the first try (see "What counts as a successful action" in §5). Everything
else here (vLLM, removals, model pulls) is still
correct-by-code-review, not correct-by-having-watched-it-work: every test
for the agent, the executors, and the check-in/reporting API mocks
`subprocess.run`, HTTP, and Prisma. See "Known unverified assumptions" at
the end before enabling apply on any real host.

## 1. Enrolling a host

The agent is installed with one command, run as root on the target host:

```bash
curl -fsSL https://<your-zllama-host>/api/agent/install | bash -s -- \
  --token <enrollment-token> --server https://<your-zllama-host>
```

(or download `install.sh` first and run it locally — same script, same
flags: `--token`, `--server`, optional `--interval`, default `30s`, and any
number of `--vllm-model-path <dir>` — see below.)

- `--server` is pre-filled by the `/api/agent/install` route with the
  server's own `NEXTAUTH_URL` when fetched that way; pass it explicitly if
  you download the raw script from `/api/agent/package` instead.
- `--token` is **not** per-host. It is the single shared secret in the
  zllama server's own `.env` (`AGENT_ENROLL_TOKEN`) — an admin sets it once
  and hands it out (out of band — Slack, a password manager, whatever your
  org uses for shared secrets) to whoever is enrolling hosts. A valid token
  only proves "this host may report facts"; it grants nothing else.

The script downloads the agent source from `/api/agent/package`, installs it
into a venv under `/opt/zllama-agent/`, writes `/etc/zllama/agent.yaml`
(mode `0600`, since it holds the token), and installs + starts a systemd
unit (`zllama-agent.service`) that runs `python -m zllama_agent.main` on a
loop.

Critically, `install.sh` always writes **`converge: false`** into
`agent.yaml`, regardless of what the host will eventually be for. A newly
enrolled host reports its facts (OS, GPUs, installed runtimes) every
interval and does nothing else — see §5 for why, and how to change it later.

### Reporting vLLM models outside the managed cache (`vllm_model_paths`)

vLLM installs nothing into itself: the agent's managed HF
cache (`VLLM_MODEL_CACHE_ROOT`) is scanned automatically, but many vLLM
hosts also serve weights staged by hand somewhere else — a shared NFS
mount, a manually downloaded checkpoint, a directory a previous operator
set up before this agent existed. `vllm_model_paths` in `agent.yaml` is an
extra list of directories the agent scans on every check-in, in addition
to the managed cache:

```yaml
vllm_model_paths:
  - /srv/models
  - /mnt/shared-weights
```

Set it with a repeatable `--vllm-model-path` flag at install time —
`--vllm-model-path /srv/models --vllm-model-path /mnt/shared-weights` — or
by editing `agent.yaml` directly and restarting the service (config is only
read at process start, same as every other field). Each configured path is
scanned the same way: if the directory itself contains a model marker
(`config.json`, `model_index.json`, or any `*.safetensors` file), it is
reported as one model named by its own directory basename; otherwise its
immediate children are scanned the same way, so a path can point either
straight at one model or at a directory holding several. A configured path
that turns out to be missing or unreadable is logged and skipped — it never
suppresses the rest of the scan, and never turns a working HF-cache probe
into a "could not determine" result (or vice versa).

The combined inventory (HF cache ∪ configured paths, deduped by name) is
what a vLLM endpoint's linked hosts report as `HostModel` rows, and what
the admin Models page's "On disk (from linked hosts)" section reads —
see §7.

## 2. Approving the host

A host that has never checked in before is created in `approvalState:
"pending"` on its first check-in. A pending host's check-in response is
just `{ "status": "pending" }` — no desired state, no converge flag, nothing
an attacker or a misconfigured host could act on.

In the zllama admin UI, go to **Hosts** (`/admin/hosts`). The newly enrolled
node appears with a pending badge and an **Approve** button
(`POST /api/hosts/:id/approve`, admin-only). Approving a host is the only
way it starts receiving anything from `/api/agent/checkin` beyond its own
status.

## 3. Assigning a role

A role (`/admin/roles`) carries a `desiredState` declaration: which runtimes
should be present or absent, at which version (an opaque string — never
parsed as semver), and which models. An approved host with no role assigned
still gets nothing but `{ status: "approved" }` plus its own `converge`
flag — no `desired` key, because there is nothing to converge toward yet.

Assign a role from the Hosts page: pick a role from the dropdown in that
host's row (`PATCH /api/hosts/:id` with `{ roleId }`). From its next
check-in on, the host receives `desired` matching that role's declaration.

The same page has a **converge** toggle per host
(`PATCH /api/hosts/:id` with `{ converge }`). This is zllama's own
last-known opinion about that host, sent back on every check-in and now
genuinely consulted by the agent — see §5. It is also what the drift page
uses to decide whether an unmanaged host should even be compared against a
role. Flipping it off in the console **does** stop that host from applying
anything, without touching the host at all, on its very next check-in.

## 4. Reading drift

**Drift** (`/admin/drift`, admin-only) compares each host's actually
observed runtime state against its role's declared state, and now also
surfaces its most recent convergence run.

Per-runtime states, worst-first: `stale` (no check-in for 6× the agent's
interval — 3 minutes at the default 30s) → `unmanaged` (no role, no
converge, or not yet approved) → `blocked` (a GPU is reporting a failed
driver) → `drifted` (installed version doesn't match declared) →
`in_sync`.

The **Last run** column shows the host's most recent
`ConvergenceRun`: status badge (`succeeded` / `failed` / `busy` / `vetoed` /
`vetoed_remote` / `dry_run` / `no_changes` / `blocked` / `cooling_down`) and
when it started; a failed run also shows its error message. `cooling_down`
means every planned action was skipped because it is waiting out an earlier
failure — see §6. `vetoed_remote` means the console's
converge toggle was the thing that stopped this run — see §5 for how that
differs from a plain `vetoed`. That data comes from `GET /api/convergence`
(admin-gated; optionally filtered with `?hostId=`), which itself reads rows
the check-in endpoint writes whenever an agent's report includes a
`convergence` key — absence of that key writes no row, so "no runs yet"
genuinely means no runs, not a zeroed-out one.

Captured installer output (stdout/stderr) is truncated to 64 KiB per stream
before it's ever written to the database — a runaway or misbehaving
installer cannot grow that table without bound. See the comment next to
`MAX_CAPTURED_OUTPUT_CHARS` in `app/app/api/agent/checkin/route.ts`.

## 5. Letting a host actually apply changes

Three independent gates must all agree before a host will execute anything,
and all three default to the safe state. **Any single one of them being in
its default state is enough to keep the host safe** — reversing any one of
them, at any time, immediately takes the host back out of apply mode.

**Gate A — the console's opinion (`Host.converge`, the Hosts-page toggle).**
Sent back to the agent on every check-in as the `converge` field of the
response, and threaded through as `converge()`'s `remote_converge`
parameter — the function itself never reaches out to read anything; the
caller (`main.py`) passes it in explicitly, exactly like `dry_run`. If this
is `false`, **or the key is absent from the response at all** (an
unapproved host, or any other reason the server didn't say yes), the agent
fails closed: it reports `"vetoed_remote"` and executes nothing. A server
that did not explicitly say yes has not said yes. Flip it from the Hosts
page; it takes effect on the host's very next check-in, no host-side
action needed.

**Gate B — the local veto (`agent.yaml`'s `converge` field).**
Read only from the agent's own local config, never overridable by the
console: if `config.converge` is `false`, the agent reports `"vetoed"`
regardless of what gate A says. This is the host's own absolute veto, and
its label wins when both gates refuse at once (`"vetoed"`, not
`"vetoed_remote"`) — the local guarantee is the stronger one, so it gets
top billing in the audit trail. `install.sh` always writes
`converge: false`. To flip it:

```bash
sudo $EDITOR /etc/zllama/agent.yaml   # set converge: true
sudo systemctl restart zllama-agent   # config is only read at process start
```

**Gate C — the apply flag (`--allow-apply`).**
Even with gates A and B both open, any host with planned actions converges
to `dry_run` status if the `converged-once` state file
(`/var/lib/zllama-agent/converged-once`) doesn't exist. `install.sh` never
creates it — a freshly enrolled host is dry-run *by design*, no matter what
its role declares or what either converge gate says, until an operator
takes this one additional, deliberate step **on the host itself**:

```bash
sudo /opt/zllama-agent/venv/bin/python -m zllama_agent.main --allow-apply
```

This writes the state file (creating `/var/lib/zllama-agent/` if needed)
and exits immediately — it does not start the check-in loop, does not take
`--config`, and takes no token; it only ever touches that one local file.
Running it twice is a no-op. The change takes effect on the agent's *next*
check-in cycle without a service restart, since the loop re-checks the
file's existence every time.

**Reversing any gate is exactly as easy as setting it**, on purpose —
reversibility matters more than convenience here:

```bash
# Reverse gate C: remove the state file, back to dry-run.
sudo /opt/zllama-agent/venv/bin/python -m zllama_agent.main --disallow-apply

# Reverse gate B: re-veto locally.
sudo $EDITOR /etc/zllama/agent.yaml   # set converge: false
sudo systemctl restart zllama-agent

# Reverse gate A: flip the Hosts-page toggle off. Takes effect on the
# host's next check-in — no host-side action needed at all.
```

`--disallow-apply` is idempotent (removing an already-absent file is not an
error) and mutually exclusive with `--allow-apply` in the same invocation.

Putting it together, the full path from "enrolled" to "this host will
actually install/upgrade/remove a runtime" is: approve → assign a role →
turn the converge toggle **on** for that host in the Hosts UI → set
`converge: true` in `agent.yaml` and restart the service → run
`--allow-apply` on the host. Skipping any one of those steps leaves the
host safely reporting, remote-vetoed, or dry-running.

### What counts as a successful action (the post-condition)

**An installer exiting 0 is not what makes a convergence action succeed.**
Every install and upgrade is followed by a post-condition check, and only
that check decides the outcome reported to the console:

- **Ollama.** After the official installer exits 0, the agent restarts the
  `ollama` systemd unit — if `systemctl` and that unit both exist; if
  either doesn't, the restart is skipped and said so in the run's output,
  since Ollama may legitimately be run some other way. It then polls
  `http://127.0.0.1:11434/api/version` (honouring `OLLAMA_HOST` when the
  daemon listens elsewhere) for up to 30s while the service comes back. The
  action succeeds **only if the daemon is actually serving the declared
  version.** Serving anything else, or never answering at all, is a
  *failure*: a nonzero exit code, with stderr naming the installer's exit
  code, the declared version, and the version actually being served.
- **vLLM.** After `pip install vllm==<version>` exits 0, the agent runs the
  managed venv's own interpreter to import vLLM and print its version. Any
  version other than the pinned one — including an import that fails
  outright — is a failure, with both versions named. There is no service
  handling here: vLLM serving is external by design.
- **A declaration with no version** (bare `state: present`) has nothing to
  compare against, so its post-condition is only that the runtime answers
  at all.

**Why this exists.** The first live convergence run declared
`ollama 0.32.13` on a host running `0.32.3`. The installer ran with
`OLLAMA_VERSION=0.32.13` and exited 0 — and it did replace
`/usr/local/bin/ollama` with 0.32.13 — but it does **not** restart an
already-running service, so the daemon went on serving 0.32.3. The executor
trusted exit 0 and reported `succeeded`. Planning then correctly re-planned
the same upgrade on the next cycle, and the cycle after that. Failure
backoff (§6) never engaged, because it keys on *failure* and every run
"succeeded" — a success-loop is invisible to it by construction. The
installer ran **13 times in 12 minutes**. The fix is therefore at the
source rather than in backoff: an action that cannot verify its own
post-condition reports failure, which is exactly what puts it into backoff
and stops the loop.

## 6. When an action keeps failing (failure backoff)

A convergence action that fails is **not** retried on the next cycle. Before
this existed, an installer that hung and was killed at its 10-minute timeout
was re-planned and re-attempted every 30 seconds, forever — one failure
turning into an unbounded loop of service disruption on a production host.

**What enters backoff.** Only an *executor* failure: the action actually ran
and reported failure. That means its command exited non-zero (a timeout
arrives as exit 124, so it counts too) **or its post-condition did not
hold** — an installer that exited 0 while the runtime kept serving the old
version fails, and therefore backs off, exactly like one that exited 1. That
second case is not a detail: it is the only reason the 13-installer-runs
loop described in §5 cannot recur. Nothing else enters backoff. A `blocked` pull (the disk precondition said it
won't fit) is planning-only, costs nothing, and self-heals the moment space
frees up. `vetoed`, `vetoed_remote`, `dry_run`, `no_changes`, `busy` and
planning errors never ran a command at all. None of them create an entry.

**What is remembered.** An action is identified by its *fingerprint*:
`(kind, runtime, target_version, model name/repo)`. The fingerprint is
deliberately derived from the declaration, so changing the declaration
produces a different fingerprint — see "forcing an immediate retry" below.

**How long it waits.** Exponential, ×4 per consecutive failure, capped at
one hour:

| Consecutive failures | Wait before the next attempt |
|---|---|
| 1 | 60s |
| 2 | 4m |
| 3 | 16m |
| 4 | 64m → clamped to 1h |
| 5+ | 1h |

The cap is a ceiling on the wait, **never a give-up**: an action stuck at
the cap keeps being retried hourly, indefinitely, and keeps showing as
failing in the console. An agent that quietly stopped trying would be a
worse failure mode than the loop this replaces. A **success clears the
entry outright**, so the next failure of that fingerprint starts over at
60s rather than resuming a stale escalation.

The cooldown deadline is exclusive: a cycle landing exactly on it waits one
more cycle. The delays are exact multiples of the default 30s interval, so
that boundary is hit precisely rather than approximately, and rounding
toward patience is the conservative direction.

**What a skipped action looks like.** Planning is completely unaffected —
the plan still shows the action, so the console always reports the true
desired-vs-actual picture. Only execution is gated. A skipped action is
reported in the run's actions list with `outcome: "backed_off"`, the epoch
second its next attempt is due (`next_retry_at`), and how many consecutive
failures got it there. It carries **no exit code at all**, because it never
ran; a `0` there would read as "succeeded". Other actions in the same run
are unaffected: one action waiting out a failure never shields the rest of
the plan from running. If *every* planned action was skipped and nothing
else ran, the run reports the status `cooling_down`.

**Where the state lives.**

```
/var/lib/zllama-agent/backoff.json
```

Next to `converged-once`, and on disk for the same reason the feature
exists: systemd restarts the agent on failure, so an in-memory memory would
be wiped by exactly the restart it has to survive. Timestamps in it are
wall-clock epoch seconds (`time.time()`), never `time.monotonic()`, which
restarts at an arbitrary origin in each new process. Writes are atomic
(write `backoff.json.tmp`, then rename over the real file), so a crash
mid-write cannot corrupt it, and a clean cycle with nothing to remember
writes nothing at all.

If the file is corrupt or unreadable, the agent logs a warning and starts
with an empty memory. It never fails a check-in or a convergence cycle over
bookkeeping — the worst case is one extra retry.

**Forcing an immediate retry.** Two ways, both intentional:

1. **Change the declaration.** Edit the role — a different target version, a
   different model — and the action's fingerprint changes, which is a fresh
   start by construction. The stale entry is pruned on the next cycle. This
   is the normal path: "I changed something, try it now" needs no host-side
   command.
2. **Delete the state file** on the host, when you want to retry the *same*
   declaration (e.g. you fixed the underlying problem — freed a disk, fixed
   DNS — without changing what is declared):

   ```bash
   sudo rm -f /var/lib/zllama-agent/backoff.json
   ```

   Takes effect on the next cycle; no service restart needed, since the
   agent re-reads the file every cycle. Removing it only forgets the
   waiting; it never causes anything to be applied that the three gates in
   §5 wouldn't already have allowed.

## 7. Linking hosts to an endpoint

A `Host` (this agent, checking in with facts) and an `Endpoint` (an
Ollama/vLLM server the app proxies requests to) are separate records that
started out unrelated — nothing tied "the agent running on this box" to
"the server the app talks to at this URL". `Endpoint.hosts` is a many-to-many
association an admin sets explicitly from the Endpoints page (`/admin/servers`,
formerly "Servers"): edit an endpoint and pick which enrolled hosts back it.
`PUT /api/servers/:id` accepts a `hostIds` array, validates every id exists
first (an unknown id fails the whole write with 400, before anything is
persisted), and replaces the association via a Prisma `set` — the write
never touches host columns, only the join.

This association is what lets zllama credit a vLLM endpoint with real
on-disk facts: since vLLM's `/v1/models` API can't tell you what's sitting
unused in a cache directory, `GET /api/admin/models` for a vLLM endpoint
additionally loads its linked hosts' `HostModel` rows (`runtimeKind:
"vllm"`) and returns them as a separate `hostModels` array. The admin
Models page renders these in their own "On disk (from linked hosts)"
section — deliberately never merged into the served-model list by matching
names, because served names and on-disk directory names routinely differ
(a model served as `nemotron-3-super` has been observed on disk in a
directory literally named `model`). An endpoint with no linked hosts simply
shows an empty on-disk section; an Ollama endpoint's response is unaffected
entirely, since Ollama's own API already reports real on-disk truth.

## Known unverified assumptions

**Confirmed by the first live run.** The Ollama executor pins a version by
setting the `OLLAMA_VERSION` environment variable before invoking Ollama's
official install script (`curl -fsSL https://ollama.com/install.sh | sh`).
That assumption held: the live upgrade put the declared 0.32.13 binary on
disk at `/usr/local/bin/ollama`. What did *not* hold was the unstated
assumption sitting next to it — that installing a binary is the same thing
as running it. It is not; see §5. Success is now defined as the runtime
*serving* the declared version, which is the only claim the console makes.

**Still unverified.** Everything else. No vLLM install, no runtime removal,
and no model pull was ever run against real hardware by the original author; every
test for those paths mocks `subprocess.run` and HTTP. The vLLM
post-condition (importing the pinned version out of the managed venv) is
correct-by-code-review only. **Run a real smoke test on a disposable host
before enabling apply (`--allow-apply` + `converge: true`) on any host that
matters** — and expect that run to teach you something the tests could
not, because the first one did.
