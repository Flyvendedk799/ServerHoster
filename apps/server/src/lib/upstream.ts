/**
 * Single source of truth for the upstream GitHub repo. All places in the
 * server that reach out to GitHub for the project (release checks, install
 * scripts referenced from docs, future webhook helpers) should read these
 * constants instead of hardcoding a slug.
 *
 * To fork: change DEFAULT_UPSTREAM_SLUG below — and run `grep -rn
 * "<GITHUB_OWNER>/localsurv"` to catch the install scripts and CI workflow,
 * which carry the same sentinel and are documented in `docs/forking.md`.
 *
 * Operators can also override at runtime via LOCALSURV_UPSTREAM_SLUG, useful
 * for forks that want to keep the upstream check pointing at their own
 * release feed without rebuilding.
 */

const DEFAULT_UPSTREAM_SLUG = "<GITHUB_OWNER>/localsurv";

export function getUpstreamSlug(): string {
  return process.env.LOCALSURV_UPSTREAM_SLUG?.trim() || DEFAULT_UPSTREAM_SLUG;
}

export function getUpstreamRepoUrl(): string {
  return `https://github.com/${getUpstreamSlug()}.git`;
}

export function getReleasesLatestUrl(): string {
  return `https://api.github.com/repos/${getUpstreamSlug()}/releases/latest`;
}

export function isUpstreamConfigured(): boolean {
  return !getUpstreamSlug().includes("<GITHUB_OWNER>");
}
