# CLAUDE.md — zllama console (`app/`)

Guidance for AI coding assistants (and humans) working on the console. Read
the root `CLAUDE.md` first for the project-wide decisions.

## Project Overview

zllama is a self-hosted management and monitoring console for Ollama and vLLM
endpoints (forked from ollama-admin). It provides endpoint and model
management, an API-key gateway with request logging and usage metrics, a
model discovery catalog, and — fed by the optional fleet agent in `../agent`
— host/GPU inventory, roles, drift and convergence reporting. Everything sits
behind authentication with role-based access control. The upstream chat
client was intentionally removed.

## Tech Stack

| Layer             | Technology                                    |
|-------------------|-----------------------------------------------|
| Framework         | Next.js 16 (App Router)                       |
| Language          | TypeScript (strict mode)                      |
| ORM               | Prisma (SQLite default, PostgreSQL optional)  |
| Auth              | NextAuth.js v4 (JWT strategy, DB credentials) |
| i18n              | next-intl (en, es, ca, fr, hi, ja, zh)        |
| Styling           | Tailwind CSS                                  |
| Syntax highlight  | Shiki                                         |
| Data fetching     | Client components: `useEffect` + `fetch`, polled via `setInterval`. Server components/route handlers: `fetch` and Prisma directly. |
| Tests             | Vitest (unit) + Playwright (e2e)              |
| Containers        | Docker + Docker Compose (built from source; no published images) |

## Architecture

### Gateway Pattern
Inference API requests go through `/api/proxy/[...path]` — never call an
endpoint directly from the client. The proxy handles endpoint selection,
engine-specific path allow-listing (`lib/engines/`), logging, token counting,
and error normalization.

### Engines
`lib/engines/` holds one adapter per engine kind (`ollama`, `vllm`) declaring
its capabilities and proxyable paths. vLLM installs nothing into itself, so
its model-management capabilities are false; on-disk vLLM weights come from
linked hosts' agent reports instead.

### Auth & Middleware
- `proxy.ts` (Next.js 16 file convention, replaces `middleware.ts`) is a first line of defense on all routes except public paths (`/api/auth`, `/api/setup`, `/api/health`, `/api/agent`, `/setup`, `/auth`)
- Route handlers enforce their own authentication/authorization via `lib/require-auth.ts` (`requireAuth` / `requireAdminAuth`) or `lib/require-admin.ts` — do not rely on `proxy.ts` alone when adding a route
- API keys authenticate `/api/proxy/*` only and are validated against the database via `lib/validate-api-key.ts` (the `zl-`/`oa-` header prefix alone grants nothing); every other route requires a session
- `/api/agent/checkin` authenticates with the shared `AGENT_ENROLL_TOKEN` bearer token; a check-in can never change a host's approval, role or converge flag
- Setup-not-completed redirects to `/setup` wizard
- `AUTH_DISABLED=true` bypasses login for local dev
- Admin-only guards enforced by `proxy.ts`, by path: `/admin/*`, `/api/admin/*`, `/api/users` (except `/api/users/me`), `/api/api-keys`, `/discover`, `/api/catalog`. Other routes (`/api/servers`, `/api/settings`, `/api/logs/export`, hosts/roles/drift/convergence) are admin-only at the handler
- User model has roles: `admin` | `user`; first admin is created during setup wizard
- JWT strategy with bcrypt password hashing

### Endpoints and hosts
Endpoint configuration lives in the database (`Endpoint`; the UI and some
routes still say "servers"). Each log entry is tied to an endpoint. Hosts
(`Host`) are created by agent check-ins and linked to endpoints explicitly by
an admin.

### Model Catalog
The `/discover` page scrapes ollama.com for the model catalog. Results are cached in an in-memory, module-level variable per process (30-minute TTL) — lost on restart, not shared across processes. `CATALOG_RATE_LIMIT_MS` and `CATALOG_REFRESH_ENABLED` are defined in `lib/constants.ts` but not currently read by the catalog route. Admin-only access.

### Database
- SQLite by default (`file:./zllama.db`), PostgreSQL via `DATABASE_URL`
- `scripts/prisma-provider.js` dynamically sets the provider based on `DATABASE_URL`
- `scripts/verify-endpoint-migration.sh` checks that the Server → Endpoint migration preserves rows and foreign keys (needs `sqlite3`)

## Project Structure

```
app/
├── app/
│   ├── (admin)/admin/     # models, servers (endpoints), hosts, roles, drift, users, logs, metrics, api-keys, settings
│   ├── (discover)/discover/ # Model catalog / discovery
│   ├── (gpu)/gpu/         # GPU monitoring page
│   ├── (tools)/tools/     # Utility tools (embeddings, OCR)
│   ├── (setup)/setup/     # Onboarding wizard
│   ├── auth/              # Sign-in / register
│   ├── settings/          # User settings
│   ├── api/               # API routes (see below)
│   ├── layout.tsx         # Root layout (providers, theme, i18n, brand fonts)
│   └── page.tsx           # Operations dashboard
├── components/            # dashboard/, layout/, providers/, ui/
├── lib/                   # auth, prisma, engines/, drift, desired-state, fleet-gpu, upstream, rate limiting, …
├── prisma/                # schema.prisma + migrations/
├── messages/              # i18n translation files
├── e2e/                   # Playwright E2E tests
├── scripts/               # Prisma provider switch, migration check
├── docker-compose.yml
├── Dockerfile             # build context is the repo root (ships ../agent)
└── .env.example
```

### Key API Routes

| Route                         | Purpose                          |
|-------------------------------|----------------------------------|
| `/api/proxy/[...path]`        | Gateway to Ollama / vLLM         |
| `/api/dashboard`              | Aggregated dashboard data        |
| `/api/admin/models`           | Model list/pull/delete/copy/show |
| `/api/servers`                | Endpoint CRUD + health checks    |
| `/api/logs`                   | Request logs + export            |
| `/api/metrics`                | Usage metrics aggregation        |
| `/api/catalog`                | Model catalog (scraped)          |
| `/api/users`                  | User management (admin-only)     |
| `/api/api-keys`               | API key management               |
| `/api/gpu`                    | GPU stats from fleet agent check-ins |
| `/api/agent/checkin`          | Agent fact reports (token auth)  |
| `/api/agent/install`, `/api/agent/package` | Serve the agent installer and source |
| `/api/hosts`                  | Host approval, role, converge toggle |
| `/api/roles`                  | Role (desired state) CRUD        |
| `/api/drift`                  | Declared vs observed state       |
| `/api/convergence`            | Convergence run history          |
| `/api/upstream`               | Latest upstream Ollama release   |
| `/api/setup/*`                | Setup wizard endpoints           |
| `/api/settings`               | System settings                  |
| `/api/health`                 | Liveness check (public)          |

### Database Models
`Endpoint`, `User`, `Log`, `ApiKey`, `Settings`, `Host`, `Gpu`, `Runtime`,
`HostModel`, `Role`, `ConvergenceRun`. (`Chat`, `Message`, `Preset` and
`CatalogModel` were removed — see the migrations.)

## Environment Variables

See `.env.example` and the configuration table in the root `README.md`.

---

## Coding Standards

### Language
All code, comments, commit messages and documentation in English.

### Code Comments
Comment the non-obvious *why* — business rules, safety invariants, workarounds
with references. Don't restate what the code does; don't leave commented-out
code.

### TypeScript & React
- TypeScript strict mode everywhere
- Prefer named exports over default exports
- Use `async/await` — no raw `.then()` chains
- All UI strings go through next-intl (`useTranslations`) — never hardcode user-facing text; add keys to every locale
- Handle all states explicitly: empty, loading, error, success
- Use loading skeletons instead of generic spinners
- Error messages must be actionable
- Follow existing file and folder conventions

### Testing
- **Unit tests**: Vitest — utilities, API route handlers, business logic
- **E2E tests**: Playwright — critical user flows
- Tests go next to the source file as `*.test.ts` / `*.test.tsx`, or under `__tests__/`
- When fixing a bug, write a test that reproduces it first
- Before considering work done: `npm test`, `npx tsc --noEmit`, `npm run lint`, `npm run build`

### Accessibility
Target WCAG 2.1 AA:
- Minimum 4.5:1 contrast ratio for normal text
- Full keyboard navigation on all interactive elements
- ARIA roles and labels on custom components

### Commits
- Conventional Commits: `type(scope): short description` (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`)
- One logical change per commit; use the body for the "why"
- Bump `package.json` with `npm version <patch|minor|major> --no-git-tag-version` for user-visible changes
