# Release process

LocalSURV uses [Semantic Versioning](https://semver.org/). We tag releases on `main` and ship a Docker image, an npm package, and a Homebrew formula bump per tag.

## Release gates (no exceptions)

A release is shippable when **every required gate** in [`docs/readiness-checklist.md`](readiness-checklist.md) is green. The CI job `readiness-gates` (`.github/workflows/ci.yml`) runs `npm run verify:readiness`, which consumes [`ops/release-gates.json`](../ops/release-gates.json) and writes the per-sequence scorecard to `ops/readiness-scorecard.json`.

Required CI checks before tagging a stable release:

| Check               | Job                    | Notes                                                       |
| ------------------- | ---------------------- | ----------------------------------------------------------- |
| Typecheck           | `build-test`           | `tsc --noEmit -p apps/server/tsconfig.json`                 |
| Lint + format       | `lint`                 | ESLint + Prettier                                           |
| Unit + integration  | `build-test`           | `node --test` over the server suite                         |
| Web smoke           | `build-test`           | Vite/React smoke checks                                     |
| Packaging smoke     | `packaging-smoke`      | shellcheck install.sh, parse install.ps1, .pkg/.msi scripts |
| Readiness gates     | `readiness-gates`      | `npm run verify:readiness` against `ops/release-gates.json` |
| Docker build + run  | `docker-build`         | image must surface CLI version                              |
| Homebrew formula    | `homebrew-smoke`       | `brew audit --strict --formula`                             |
| Performance budgets | `npm run perf:budgets` | thresholds in `ops/perf-budgets.json`                       |

If any required gate fails, **do not bypass it**. De-scope features instead.

## Performance budgets

The performance smoke harness lives at `scripts/perf/check-budgets.ts` and is fed by [`ops/perf-budgets.json`](../ops/perf-budgets.json). Run it locally with `npm run perf:budgets`. Numbers are guard-rails, not optimisation targets — bumping a budget needs a corresponding release-notes line item explaining why.

## Artifact manifest

Every release tag publishes:

- `localsurv-<version>-source.tar.gz` (raw source)
- `survhub-server-<version>.tgz` (npm pack output)
- Docker image `ghcr.io/<owner>/localsurv:<version>` and `:latest`
- `SHA256SUMS` covering all of the above (cosign-keyless signed in the release workflow)

The `SHA256SUMS` checksum file plus the readiness scorecard (`ops/readiness-scorecard.json`) constitute the **release manifest**: with both, anyone can re-derive the release from the source tarball and confirm it matches what shipped. Verify a downloaded artefact with `sha256sum -c SHA256SUMS` (Linux/macOS) or `Get-FileHash -Algorithm SHA256` (Windows) before installing.

## Versioning

- **MAJOR** — breaking API, breaking CLI, breaking DB schema (without a migration path)
- **MINOR** — new feature, no break
- **PATCH** — bug fix only, no feature

Pre-releases use `-alpha.N`, `-beta.N`, `-rc.N` suffixes.

## Release checklist

1. **Freeze**: merge open PRs or defer them.
2. **Update `CHANGELOG.md`**:
   - Move everything under **[Unreleased]** to a new `## [x.y.z] — YYYY-MM-DD` section
   - Keep the `[Unreleased]` header in place with an empty body
3. **Bump versions** in the root and every workspace package:
   ```bash
   npm version x.y.z --workspaces --no-git-tag-version
   npm version x.y.z --no-git-tag-version   # root
   ```
4. **Run the full test suite**:
   ```bash
   npm run build
   npm run test -w @survhub/server
   npm run test:smoke -w @survhub/web
   ```
5. **Commit** the version bump + changelog:
   ```bash
   git commit -am "chore: release vx.y.z"
   ```
6. **Tag**:
   ```bash
   git tag -a vx.y.z -m "vx.y.z"
   git push origin main --tags
   ```
7. **GitHub Release** — create a release from the tag, paste the new changelog section as the body, optionally attach the Docker image digest.
8. **Docker image** — CI builds and pushes `localsurv:x.y.z` and `localsurv:latest` automatically when the tag is pushed (see `.github/workflows/ci.yml` — `docker-build` job).
9. **Homebrew** — update `packaging/Formula/localsurv.rb`:
   - Bump the `url` tarball version
   - Update `sha256` with:
     ```bash
     curl -sL https://github.com/your-org/localsurv/archive/refs/tags/vx.y.z.tar.gz | shasum -a 256
     ```
   - Commit the formula (or open a PR against your tap)
10. **npm** — `npm publish --workspace @survhub/server` (if/when you start publishing the package).

## Generating the changelog automatically

If you use [Conventional Commits](https://www.conventionalcommits.org/), a tool like `git-cliff` or `conventional-changelog-cli` can regenerate `CHANGELOG.md` from git history:

```bash
npx conventional-changelog-cli -p angular -i CHANGELOG.md -s -r 0
```

This project writes changelog entries manually so that release notes stay narrative and feature-grouped rather than listing every commit.

## Commit conventions

Not strictly enforced, but recommended:

- `feat: add metrics sparkline component`
- `fix: git poller tab split bug`
- `docs: clarify cloudflare tunnel setup`
- `refactor: extract settings module`
- `chore: bump typescript to 5.8`
- `test: cover dependency cycle detection`
