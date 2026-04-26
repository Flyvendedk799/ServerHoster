# Contributing to LocalSURV

Thanks for wanting to make LocalSURV better. This guide covers everything you need to start contributing.

## Development setup

```bash
git clone https://github.com/your-org/localsurv.git
cd localsurv
npm install
export SURVHUB_SECRET_KEY=$(openssl rand -base64 32)

# Run the two dev servers in parallel
npm run dev -w @survhub/server   # terminal 1 — API on :8787
npm run dev -w @survhub/web      # terminal 2 — dashboard on :5173
```

Open `http://localhost:5173`. Any code change auto-reloads both the server (via `tsx watch`) and the web (via Vite HMR).

### Useful scripts

```bash
npm run build                          # full workspace build (tsc + vite)
npm run test -w @survhub/server        # server tests (node:test)
npm run test:smoke -w @survhub/web     # web smoke tests
npm run lint                           # eslint
npm run format:check                   # prettier check
npm run format                         # prettier write
```

## Project layout

```
apps/
  server/           Fastify API, runtime, background workers, CLI
    src/
      routes/       HTTP route modules
      services/     Domain logic (deploy, ssl, runtime, databases, metrics, ...)
      lib/          Shared utilities
  web/              React + Vite dashboard
    src/
      pages/        Top-level pages
      components/   Reusable UI
      lib/          api, ws, toast, confirm
packages/
  shared/           Shared types
docs/               Contributor and user docs
.github/
  workflows/ci.yml  GitHub Actions
```

## Contribution workflow

1. **Open an issue first** for anything bigger than a one-line fix so we can agree on the approach before you spend time.
2. **Branch from `main`.** Name branches descriptively: `fix/git-poller-tab-bug`, `feature/cloudflare-dns01`.
3. **Write tests.** If you change behavior, either the existing test suite should cover it or you add a test that would have failed before your change.
4. **Keep commits focused.** One logical change per commit, with a message that explains *why*, not just *what*.
5. **Run before pushing:**
   ```bash
   npm run build
   npm run test -w @survhub/server
   ```
6. **Open a PR** against `main` and fill in the template.

## Code style

- TypeScript, strict mode everywhere. No `any` unless a type boundary forces it.
- Prefer explicit types on exported functions and route handlers.
- Use the existing token-based CSS variables (`var(--bg-surface)`, `var(--text-muted)`, etc.) — don't hard-code colors.
- No runtime config files — configuration flows through `src/config.ts` → `ctx.config`.
- No new runtime dependencies without a good reason. The project goal is to run out-of-the-box with minimal friction; every `package.json` addition is a permanent cost.
- Comments explain **why**, not **what**. If you need a comment to explain what the code does, rename things first.

## Adding a route

1. Create or edit a module under `apps/server/src/routes/`.
2. Define a `zod` schema for any input.
3. Register the route inside a `register<Thing>Routes(ctx)` function.
4. Import and call it from `apps/server/src/app.ts`.
5. Document the route in `docs/api-reference.md`.
6. Add a test under `apps/server/src/*.test.ts` that exercises the happy path and at least one error path with `ctx.app.inject()`.

## Adding a background worker

Start loops return a stop function; push them onto `ctx.shutdownTasks` in `buildApp()` so they get cleaned up on `gracefulShutdown`. See `startMetricsLoop` and `startSystemHealthLoop` for the pattern.

## Reporting bugs

Open a **Bug Report** issue with:

- What you did
- What you expected
- What actually happened
- Your platform (`node --version`, OS, Docker version)
- Relevant log output from the server stdout and the Services page

## Proposing features

Open a **Feature Request** issue. Explain the problem you're trying to solve before the solution — "I want X because Y" beats "add X".

## Release process

See [docs/releases.md](docs/releases.md).

## Code of Conduct

Be kind. Read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
