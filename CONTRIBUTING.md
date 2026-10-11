# Contributing

zllama is **unmaintained**. The original author no longer runs it, so pull
requests and issues may not be reviewed or answered. Forking is encouraged.

If you do send a change, please keep it passing the same gates CI runs.

## Gates

Console (`app/`, Node.js 20+):

```bash
cd app
npm ci
npm test            # Vitest
npx tsc --noEmit    # type check
npm run lint        # ESLint
npm run build       # production build
```

Agent (`agent/`, Python 3.12+):

```bash
cd agent
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -e .
.venv/bin/python -m pytest -q
.venv/bin/ruff check .
```

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`), optionally
  scoped: `fix(agent): …`.
- Add or update tests with every behaviour change; when fixing a bug, add a
  test that reproduces it first.
- User-facing strings go through next-intl; add keys to every locale in
  `app/messages/`.
- No chat feature: zllama is a management and monitoring console.
- No real data in code, tests, fixtures, docs or screenshots. Use private-range
  IPs (10.x / 192.168.x), obviously fake hostnames and masked fake keys. Never
  commit `.env` files, databases or credentials.

By contributing you agree that your contributions are licensed under the MIT
License (see [LICENSE](LICENSE)) and that you follow the
[Code of Conduct](CODE_OF_CONDUCT.md).
