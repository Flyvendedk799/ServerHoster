# Release process

LocalSURV uses [Semantic Versioning](https://semver.org/). We tag releases on `main` and ship a Docker image, an npm package, and a Homebrew formula bump per tag.

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
