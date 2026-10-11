# CLAUDE.md — zllama (repo root)

Guidance for AI coding assistants (and humans) working in this repository.

zllama is a self-hosted web console for managing and monitoring fleets of
[Ollama](https://ollama.com) and vLLM servers, plus an optional per-host
fleet agent. It is a fork of
[ollama-admin](https://github.com/ollama-admin/ollama-admin) (MIT), stripped
and rebranded. The project is unmaintained; see `README.md`.

## Repo layout

| Path | What it is |
|------|------------|
| `app/` | The console (Next.js + Prisma). Has its own `CLAUDE.md` with tech stack, architecture and coding standards — read it before touching `app/`. |
| `agent/` | The Python fleet agent (`zllama_agent`), its installer and systemd unit. Served to hosts by the console. |
| `docs/fleet-agent.md` | Operator guide for the agent: enrollment, approval, roles, drift, convergence opt-in, backoff. |
| `prototype/index.html` | Self-contained static design mockup (no build step). Reference for palette, typography and layout only — build features in `app/`. |

## Non-negotiable project decisions

1. **No chat feature.** zllama is a management/monitoring tool. The upstream
   chat client was deliberately removed. The only permitted inference UI is a
   per-model **Test console**: one prompt in, one response out, with operator
   stats (first-token latency, tok/s, token count, VRAM delta). Nothing
   persisted. Do not reintroduce chat, conversations, or presets.
2. **No sensitive data anywhere** — code, tests, fixtures, docs, screenshots.
   Demo/mock data must use private-range IPs (10.x / 192.168.x), obviously
   fake hostnames (`gpu-node-1`, `spark-1`, `*.example.internal`) and
   obviously fake masked API keys. Never commit `.env`, databases, real
   hostnames, or credentials.
3. **Convergence stays opt-in and fail-closed.** Never add a path by which
   the console alone can make a host execute changes; the local
   `converge: true` + `--allow-apply` gates must remain host-side.
4. **Brand palette** (used in `app/app/globals.css` and the prototype):
   Gunmetal `#2A3439` (primary/nav), Deep Gunmetal `#1C2427` (hover/active),
   Steel Gray `#4D585E` (icons/secondary), Brushed Silver `#C0C0C0` (borders),
   Soft Silver `#E5E7E8` (cards), Mist Gray `#F4F6F5` (page bg),
   Emerald `#1F8A4C` (accent), Forest `#0F5F35` (accent hover),
   Sage `#A7CBA5` (success/subtle), Charcoal `#121617` (text).
   Fonts: Space Grotesk (display), IBM Plex Sans (body), IBM Plex Mono (data).
5. **Model Factory is roadmap-only.**

## Working in this repo

- Console: `cd app`, then `npm run dev`, `npm test` (Vitest),
  `npx tsc --noEmit`, `npm run lint`, `npm run build`, `npm run test:e2e`
  (Playwright).
- Local dev quick start: `cp .env.example .env`, set a `NEXTAUTH_SECRET`,
  `npx prisma migrate deploy`, `npm run dev` — first boot redirects to the
  `/setup` wizard.
- Agent: `cd agent`, create a venv, `pip install -r requirements.txt -e .`,
  then `python -m pytest -q` and `ruff check .`.
- All of the above must pass before a change is considered done.
- Commits follow Conventional Commits (`type(scope): description`).
