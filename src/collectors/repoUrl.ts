/**
 * Normalizes the many URL forms npm/GitHub data uses for the same repo into
 * a stable `owner/name` key. Handles:
 *   git+ssh://git@github.com/owner/repo.git
 *   git+https://github.com/owner/repo.git
 *   git://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo.git
 *   git@github.com:owner/repo.git
 *   owner/repo   (npm's shorthand form)
 * Returns null if the value isn't a recognizable GitHub repo reference --
 * this matters because package.json `repository` is a free-text field
 * publishers control, and TrustGraph must not guess at malformed input.
 */
export function normalizeGithubRepo(raw: string | null | undefined): { owner: string; name: string } | null {
  if (!raw) return null;
  let s = raw.trim();

  // npm shorthand: "owner/repo"
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    const [owner, name] = s.split("/");
    return owner && name ? { owner, name: name.replace(/\.git$/, "") } : null;
  }

  s = s.replace(/^git\+/, "");
  s = s.replace(/^git@([^:]+):/, "https://$1/");
  s = s.replace(/^git:\/\//, "https://");
  s = s.replace(/\.git$/, "");

  try {
    const url = new URL(s);
    if (!url.hostname.includes("github.com")) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0]!, name: parts[1]! };
  } catch {
    return null;
  }
}

export function repoKey(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}
