# Security

## Project status

zllama is **unmaintained** and provided as-is under the MIT License. The
original author no longer runs it. There are no supported versions and no
guarantee that a reported issue will be fixed. If you deploy it, you own its
security.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository
(Security tab → "Report a vulnerability"). Do not open a public issue for a
suspected vulnerability. Include affected files or routes, reproduction steps,
and impact. Reports may not receive a response; if you maintain a fork,
consider fixing it there and sharing the patch.

## Deployment guidance

zllama was built for a single trusted operator on a private network. Treat
the following as requirements, not suggestions.

### Never expose the console directly to the internet

- The bundled compose file publishes the console on `127.0.0.1` only. Keep it
  that way unless something trusted sits in front of it.
- To reach it from other machines, put it behind a reverse proxy that
  terminates TLS **and** enforces its own authentication (SSO/identity-aware
  proxy, mTLS) or restricts access to a VPN / private network. The built-in
  login is a convenience, not a perimeter: it has not had an external
  security review.
- Set a strong, unique `NEXTAUTH_SECRET`. Never set `AUTH_DISABLED=true`
  outside local development.
- Set `TRUST_PROXY_HEADERS=true` only if your proxy *overwrites*
  `X-Forwarded-For`; otherwise clients can spoof their address for rate
  limiting.
- Request logs store prompt content by default (`LOG_STORE_PROMPTS=true`).
  Turn it off if prompts may contain sensitive data.
- The `/api/proxy` gateway forwards requests to your inference servers. Anyone
  holding a valid session or API key can use your GPUs. Issue API keys
  sparingly and revoke unused ones.

### The agent enrollment token is a shared bearer secret

- `AGENT_ENROLL_TOKEN` is one token shared by every host, not a per-host
  credential, and hosts are identified only by the node name they report.
  Anyone who has the token can register new hosts, and can also check in
  *as an existing host* by reusing its node name — overwriting its facts
  (inventory, GPU stats, run results) and receiving its role's desired state.
- New hosts land in a `pending` state and receive nothing until an admin
  approves them, so review the Hosts page before approving anything you did
  not enroll yourself.
- Generate it randomly (`openssl rand -hex 32`), distribute it out of band,
  and rotate it (change the server value and re-run the installer on each
  host) if it may have leaked. Leaving it unset disables check-ins entirely.
- Agents should reach the console over HTTPS on a trusted network; the token
  is sent as a bearer header on every check-in.
- `/api/agent/*` bypasses the session check: `install` and `package` serve
  the installer and agent source to anyone who can reach the console (they
  contain no secrets), and `checkin` is protected only by the token.

### Convergence runs installers as root — opt-in only

- When enabled, the agent executes runtime installers and package installs
  (Ollama's official install script, `pip install vllm==…`) **as root** on the
  host, driven by role declarations stored in the console. Anyone with admin
  access to the console can change those declarations.
- It is therefore off by default and requires deliberate action on both
  sides: `converge: true` in the host's own `/etc/zllama/agent.yaml`, the
  per-host converge toggle in the console, and a one-time
  `python -m zllama_agent.main --allow-apply` run on the host itself. Without
  all three, the agent only reports (or dry-runs).
- Enable it only on hosts you are prepared to have modified automatically,
  and only if console admin access is as tightly held as root on those hosts.
  Test on a disposable host first — see `docs/fleet-agent.md` ("Known
  unverified assumptions").
- To revoke quickly: flip the console toggle off (next check-in), or run
  `--disallow-apply` / set `converge: false` on the host.
