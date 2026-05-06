# Forking LocalSURV

LocalSURV ships with the literal sentinel `<GITHUB_OWNER>` everywhere it would otherwise need a hard-coded GitHub org. When you cut your own fork, do a single search-and-replace and you're done.

## What to change

```bash
# from the repo root, after forking:
grep -rn "<GITHUB_OWNER>/localsurv" \
  install.sh \
  install.ps1 \
  apps/server/src/lib/upstream.ts \
  README.md
```

The four canonical spots:

| Path                              | What it controls                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `install.sh`                      | The bash one-liner installer's default `git clone` URL.                                                              |
| `install.ps1`                     | The PowerShell installer's default `git clone` URL.                                                                  |
| `apps/server/src/lib/upstream.ts` | `DEFAULT_UPSTREAM_SLUG` — drives the in-dashboard "update available" banner and any future server-side GitHub calls. |
| `README.md`                       | The quickstart copy block.                                                                                           |

Replace `<GITHUB_OWNER>` with your GitHub username or org (e.g. `acme`). The release CI workflow (`.github/workflows/release.yml`) reads `${{ github.repository }}` automatically, so it does not need editing.

## Optional runtime overrides

You don't strictly have to fork the source to repoint the update check or installer. Any of these takes precedence over the compiled-in default:

- `LOCALSURV_UPSTREAM_SLUG=acme/localsurv` — the running server uses this for `update_check.*` lookups.
- `LOCALSURV_REPO=https://github.com/acme/localsurv.git` — the bash installer clones this URL.
- The `-RepoUrl` parameter on `install.ps1` — the PowerShell installer clones this URL.

Use the env vars when you want to test a different upstream without rebuilding; use the source edit when you're publishing a fork.
