import { getDb } from "../db/client.js";
import type { Contributor, Repository } from "../models/types.js";

export function upsertRepository(repo: Repository): void {
  getDb()
    .prepare(
      `INSERT INTO repository (id, owner, name, is_org_owned, url, default_branch, first_seen)
       VALUES (@id, @owner, @name, @isOrgOwned, @url, @defaultBranch, @firstSeen)
       ON CONFLICT(id) DO UPDATE SET
         is_org_owned = excluded.is_org_owned,
         default_branch = excluded.default_branch`
    )
    .run({ ...repo, isOrgOwned: repo.isOrgOwned ? 1 : 0 });
}

export function getRepository(id: string): Repository | null {
  const row = getDb().prepare("SELECT * FROM repository WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    isOrgOwned: !!row.is_org_owned,
    url: row.url,
    defaultBranch: row.default_branch,
    firstSeen: row.first_seen,
  };
}

/** Which packages currently resolve to this repository -- the monorepo case (Test 8). */
export function getPackagesForRepository(repositoryId: string): string[] {
  const rows = getDb()
    .prepare("SELECT id FROM package WHERE repository_id = ?")
    .all(repositoryId) as { id: string }[];
  return rows.map((r) => r.id);
}

export function replaceContributors(repositoryId: string, contributors: Contributor[]): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM contributor WHERE repository_id = ?").run(repositoryId);
    const insert = db.prepare(
      `INSERT INTO contributor (id, repository_id, github_username, commit_count, is_anonymous, data_as_of)
       VALUES (@id, @repositoryId, @githubUsername, @commitCount, @isAnonymous, @dataAsOf)`
    );
    for (const c of contributors) {
      insert.run({ ...c, isAnonymous: c.isAnonymous ? 1 : 0 });
    }
  });
  tx();
  // GUARDRAIL: contributors are replaced wholesale, not diffed, because the
  // MVP does not generate a `contributor_added` Observation (no reliable
  // "before" state -- see docs). This table is Context material only.
}

export function getContributorsForRepository(repositoryId: string): Contributor[] {
  const rows = getDb()
    .prepare("SELECT * FROM contributor WHERE repository_id = ? ORDER BY commit_count DESC")
    .all(repositoryId) as any[];
  return rows.map((row) => ({
    id: row.id,
    repositoryId: row.repository_id,
    githubUsername: row.github_username,
    commitCount: row.commit_count,
    isAnonymous: !!row.is_anonymous,
    dataAsOf: row.data_as_of,
  }));
}
