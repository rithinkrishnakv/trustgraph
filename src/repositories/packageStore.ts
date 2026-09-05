import { getDb } from "../db/client.js";
import type { Package, Publisher } from "../models/types.js";

export function upsertPackage(pkg: Package): void {
  getDb()
    .prepare(
      `INSERT INTO package (id, ecosystem, claimed_repository_url, repository_id, homepage, first_seen, last_modified)
       VALUES (@id, @ecosystem, @claimedRepositoryUrl, @repositoryId, @homepage, @firstSeen, @lastModified)
       ON CONFLICT(id) DO UPDATE SET
         claimed_repository_url = excluded.claimed_repository_url,
         repository_id = excluded.repository_id,
         homepage = excluded.homepage,
         last_modified = excluded.last_modified`
    )
    .run(pkg);
}

export function getPackage(id: string): Package | null {
  const row = getDb().prepare("SELECT * FROM package WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    ecosystem: row.ecosystem,
    claimedRepositoryUrl: row.claimed_repository_url,
    repositoryId: row.repository_id,
    homepage: row.homepage,
    firstSeen: row.first_seen,
    lastModified: row.last_modified,
  };
}

export function upsertPublisher(publisher: Publisher): void {
  getDb()
    .prepare(
      `INSERT INTO publisher (id, npm_email, claimed_github_username, first_seen_publishing, is_current_maintainer)
       VALUES (@id, @npmEmail, @claimedGithubUsername, @firstSeenPublishing, @isCurrentMaintainer)
       ON CONFLICT(id) DO UPDATE SET
         npm_email = COALESCE(excluded.npm_email, publisher.npm_email),
         is_current_maintainer = excluded.is_current_maintainer,
         first_seen_publishing = COALESCE(publisher.first_seen_publishing, excluded.first_seen_publishing)`
    )
    .run({ ...publisher, isCurrentMaintainer: publisher.isCurrentMaintainer ? 1 : 0 });
}

export function getPublisher(id: string): Publisher | null {
  const row = getDb().prepare("SELECT * FROM publisher WHERE id = ?").get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    npmEmail: row.npm_email,
    claimedGithubUsername: row.claimed_github_username,
    firstSeenPublishing: row.first_seen_publishing,
    isCurrentMaintainer: !!row.is_current_maintainer,
  };
}
