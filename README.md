# zllama

A self-hosted management and monitoring console for fleets of
[Ollama](https://ollama.com) and [vLLM](https://docs.vllm.ai) inference
servers. One web UI for your endpoints, their models, request logs and usage
metrics, an API-key gateway in front of them, and — optionally — a small
per-host agent that reports hardware/GPU inventory and can converge hosts
toward a declared role.

## Status: unmaintained, provided as-is

**The original author no longer runs zllama and does not maintain it.** The
code is published so others can use, study or fork it. Issues and pull
requests may never be answered. It served a single operator managing a
handful of GPU hosts; it has not been hardened for multi-tenant use, has not
had an external security review, and the convergence feature was only ever
exercised lightly on real hardware (see
[docs/fleet-agent.md](docs/fleet-agent.md)). Read [SECURITY.md](SECURITY.md)
before deploying it anywhere that matters.

No container images or packages were ever published. You build it from
source.

## Features

- **Endpoints** — register any number of Ollama or vLLM servers, with health
  checks, version reporting, and upstream Ollama release awareness.
- **Models** — list, pull, delete, copy and inspect models across Ollama
  endpoints; see served models (and, via the agent, on-disk weights) for vLLM
  endpoints.
- **Discover** — browse the ollama.com catalog, with a rough
  "will it fit / how fast" grade against your GPUs.
- **Gateway, logs and metrics** — inference traffic sent through
  `/api/proxy/...` is recorded with model, endpoint, user or API key, token
  counts and latency. Usage dashboards, log search and CSV export.
- **API keys** — issue `zl-` keys for programmatic access through the gateway.
- **Users** — admin/user roles, credentials login, first-run setup wizard.
- **Fleet agent (optional)** — a Python agent on each GPU host checks in with
  OS, GPU, runtime and on-disk model facts. GPU stats in the UI come from
  these check-ins.
- **Roles, drift and convergence (optional)** — declare which runtimes,
  versions and models a class of host should have; see per-host drift; and,
  only on hosts that have explicitly opted in, let the agent install/upgrade
  runtimes and pull models to match.
- i18n (en, es, ca, fr, hi, ja, zh), light/dark themes, density settings.

### Deliberately not included

- **No chat.** zllama is a management and monitoring tool. The upstream chat
  client was removed on purpose, along with conversations and presets. The
  only inference UI ever planned was a per-model **Test console** (one prompt
  in, one response out, with first-token latency, tok/s, token count and VRAM
  delta; nothing persisted). It was never built.
- **Model Factory** (creating model variants) remained roadmap-only.

## Architecture

```
          browser (admins/users)            API clients (zl- keys)
                    │                                │
                    ▼                                ▼
   ┌───────────────────────────────────────────────────────────────┐
   │  zllama console  (Next.js app; SQLite or PostgreSQL)          │
   │  UI · /api/proxy gateway · logs/metrics · hosts · roles/drift │
   └───────┬───────────────────────────────────────────▲───────────┘
           │ proxied inference + admin calls           │ POST /api/agent/checkin
           ▼                                           │ (Bearer AGENT_ENROLL_TOKEN)
   ┌────────────────────────┐                 ┌────────┴─────────────────┐
   │ Ollama / vLLM endpoint │◀── same host ──▶│ zllama_agent (systemd)   │
   └────────────────────────┘   (optional)    │ facts · drift · converge │
                                              └──────────────────────────┘
```

- **Console** (`app/`): Next.js 16 App Router, TypeScript, Prisma, NextAuth.
  Endpoint configuration lives in the database and is managed from the UI.
- **Agent** (`agent/`): Python 3.12, runs as a systemd service on each host.
  Every interval (default 30s) it posts its facts to the console; the response
  says whether the host is approved, what its role declares, and whether the
  console allows convergence. The agent listens on no port; the console never
  connects to it.
- An *endpoint* (a URL the console proxies to) and a *host* (a machine running
  the agent) are separate records; an admin links them explicitly.

## Quick start (Docker Compose, built from source)

Requires Docker with Compose v2.

```bash
git clone <this repository> zllama
cd zllama/app

# Minimal compose environment. Do NOT copy .env.example here: its
# DATABASE_URL is for local development and would override the container path.
cat > .env <<EOF
NEXTAUTH_SECRET=$(openssl rand -base64 32)
# Only needed if you will enroll fleet agents:
AGENT_ENROLL_TOKEN=$(openssl rand -hex 32)
EOF
chmod 600 .env

docker compose up -d --build
```

Open <http://localhost:3000>. The first visit redirects to the setup wizard,
which creates the admin account and registers your first endpoint. By default
the container reaches an Ollama running on the Docker host at
`http://host.docker.internal:11434`.

The port is published on `127.0.0.1` only. To reach the console from other
machines, put it behind a reverse proxy that terminates TLS **and** enforces
its own authentication or VPN restriction, or set `HOST_BIND` deliberately —
see [SECURITY.md](SECURITY.md). To serve it under a sub-path, set
`NEXT_PUBLIC_BASE_PATH` (a build argument — rebuild after changing it) and
include the prefix in `NEXTAUTH_URL`.

To use PostgreSQL instead of SQLite, see the commented `postgres` service in
`app/docker-compose.yml` and set `DATABASE_URL` accordingly.

## Installing the fleet agent

The agent is optional. Without it you still get endpoints, models, the
gateway, logs and metrics; you do not get GPU inventory, hosts, roles or
drift.

1. Set `AGENT_ENROLL_TOKEN` in the console's environment (see above). While
   it is unset, every check-in is rejected.
2. Make sure each host can reach the console over HTTPS. Agents cannot get
   past an interactive login page; if your browser-facing URL sits behind one,
   publish a second listener for agents on a network you trust (see
   `AGENT_BIND` in `app/docker-compose.yml`).
3. On each host, as root (needs Python 3.12+ with the `venv` module, and
   systemd):

   ```bash
   curl -fsSL https://<your-zllama-host>/api/agent/install | sudo bash -s -- \
     --token <enrollment-token> --server https://<your-zllama-host>
   ```

   This downloads the agent from the console, installs it into
   `/opt/zllama-agent/venv`, writes `/etc/zllama/agent.yaml` (mode 0600,
   always with `converge: false`) and starts `zllama-agent.service`.
4. Approve the host under **Hosts** in the console. Until it is approved it
   receives nothing but `{"status": "pending"}`.

The full operator guide — roles, drift states, the apply opt-in, backoff and
known limitations — is in [docs/fleet-agent.md](docs/fleet-agent.md).

## Convergence safety model

Convergence means the agent runs installers (Ollama's official install
script, or `pip install vllm==<version>`) **as root** on the host. It is
designed to be hard to switch on by accident and easy to switch off:

- **Dry-run by default.** A freshly installed agent only reports. Even with
  every other switch on, it plans but does not execute until someone runs
  `/opt/zllama-agent/venv/bin/python -m zllama_agent.main --allow-apply`
  *on the host itself* (`--disallow-apply` reverses it).
- **Two-sided opt-in.** The host's own `agent.yaml` must say
  `converge: true` (a local veto the console cannot override), **and** the
  console's per-host converge toggle must be on. If the console's answer is
  missing or anything other than an explicit yes, the agent does nothing.
  Turning the console toggle off takes effect on the host's next check-in;
  the local veto takes effect when the agent service is restarted.
- **Approval and roles first.** Unapproved hosts and hosts without a role get
  no desired state at all.
- **Verified post-conditions.** An installer exiting 0 is not success. After
  an Ollama upgrade the agent restarts the service and checks that the daemon
  is actually *serving* the declared version; after a vLLM install it imports
  the pinned version from the managed venv. Anything else is a failure.
- **Failure backoff.** A failed action is not retried on the next cycle: it
  waits 60s, then 4m, then 16m, then hourly, persisted across agent restarts
  in `/var/lib/zllama-agent/backoff.json`. A success resets it.
- **Bounded output.** Captured installer stdout/stderr is truncated before it
  is stored.

## Configuration

Console environment variables (see `app/.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `file:./zllama.db` (compose: `file:/data/zllama.db`) | SQLite file or `postgresql://…` connection string |
| `NEXTAUTH_SECRET` | — (required) | JWT signing secret; generate with `openssl rand -base64 32` |
| `NEXTAUTH_URL` | `http://localhost:3000` | Public base URL, including any sub-path |
| `NEXT_PUBLIC_BASE_PATH` | empty | Sub-path when served behind a reverse proxy (build time) |
| `DEFAULT_OLLAMA_URL` | `http://localhost:11434` (compose: `http://host.docker.internal:11434`) | Endpoint suggested by the setup wizard |
| `AGENT_ENROLL_TOKEN` | empty (all check-ins rejected) | Shared bearer token agents present at check-in |
| `AUTH_DISABLED` | unset | `true` bypasses login — local development only, never in a deployment |
| `TRUST_PROXY_HEADERS` | unset | `true` only behind a proxy that overwrites `X-Forwarded-For`; used for rate limiting |
| `INTERNAL_ORIGIN` | `http://127.0.0.1:$PORT` | Origin the app uses to call itself (setup-status check) |
| `LOG_RETENTION_DAYS` | `90` | Request-log retention |
| `LOG_STORE_PROMPTS` | `true` | Store prompt content in request logs; set `false` for privacy |
| `LOG_LEVEL` | unset | `debug` for verbose server logs |
| `CATALOG_REFRESH_ENABLED`, `CATALOG_RATE_LIMIT_MS` | `true`, `2000` | Defined but not currently enforced by the catalog route |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Outbound proxy for reaching ollama.com |

Compose only: `HOST_BIND` (default `127.0.0.1`) and `AGENT_BIND` (default
`127.0.0.2`) choose the host addresses port 3000 is published on.

The agent reads `/etc/zllama/agent.yaml`: `server`, `token`, `node_name`
(defaults to the short hostname), `interval` (`30s`), `converge` (`false`),
`log_level`, and `vllm_model_paths` (extra directories to scan for vLLM
weights). It is only read at process start.

## Development

```bash
# Console
cd app
cp .env.example .env          # then set NEXTAUTH_SECRET
npm install
npx prisma migrate deploy
npm run dev                   # http://localhost:3000

npm test                      # Vitest unit tests
npx tsc --noEmit              # type check
npm run lint                  # ESLint
npm run build                 # production build
npm run test:e2e              # Playwright

# Agent
cd agent
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -e .
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
```

`prototype/index.html` is a static design mockup (open it in a browser). It is
the reference for the brand palette and layouts and contains only mock data.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements and license

zllama is a fork of [ollama-admin](https://github.com/ollama-admin/ollama-admin)
(MIT), with its chat client removed and vLLM support, the fleet agent, roles,
drift and convergence added. Thanks to its authors.

Released under the MIT License — see [LICENSE](LICENSE), which preserves the
upstream copyright notice.
