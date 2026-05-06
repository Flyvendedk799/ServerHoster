export function inferNameFromRepoUrl(repoUrl) {
  const trimmed = repoUrl.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const rawName = segments.at(-1)?.replace(/\.git$/i, "") ?? "";
    return rawName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  } catch {
    const rawName =
      trimmed
        .split(/[/:]/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/\.git$/i, "") ?? "";
    return rawName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
