# API reference

Base path: `/api/v1`. All responses are JSON. All timestamps are ISO 8601 UTC.

## `POST /scans`

Scan an npm package. Debounced: if a completed scan for this package exists within `SCAN_FRESHNESS_WINDOW_MINUTES` (default 15), the existing scan is returned instead of triggering fresh collection — this is what protects the npm/GitHub rate-limit budget from repeated requests.

**Request**
```json
{ "package": "left-pad" }
```

**Response** — `201` (new scan executed) or `200` (existing fresh scan reused)
```json
{
  "scan_id": "scan_80b639e357e7bce1fbc5bdfd",
  "package": "left-pad",
  "status": "completed",
  "reused_existing_scan": false,
  "new_findings_count": 2,
  "collector_results": { "npm": "ok", "github": "ok" },
  "requested_at": "2026-09-03T09:11:09.685Z",
  "completed_at": "2026-09-03T09:11:11.193Z"
}
```

`status` is one of `running`, `completed`, `completed_partial`, `failed`. `completed_partial` means some collector sub-fetch failed but usable data was still produced — check `collector_results` for which source. `collector_results.{npm,github}` is one of `ok`, `partial`, `failed`, `skipped`.

**Errors**: `400` for an invalid/malformed package name (validation, not a network call). A scan of a package that doesn't exist on npm returns `201` with `status: "failed"` — the request itself was valid, the collection failed for a documented reason.

## `GET /scans/:scanId`

Retrieve a scan's status and collector results by id.

## `GET /packages/:package`

Package summary: claimed repository, homepage, first-seen/last-modified. `404` if the package has never been scanned.

## `GET /packages/:package/versions`

Paginated version history. Query params: `page` (default 1), `per_page` (default 20, max 100). `404` if never scanned.

## `GET /packages/:package/findings`

Paginated, time-filterable findings for a package. Query params:
- `page`, `per_page` — standard pagination
- `since` — ISO 8601 datetime; only findings created after this time

`404` if the package has never been scanned — **this is deliberate**: an empty findings list for a scanned package (`200` with `findings: []`) means "checked, nothing found," which is a different claim from "never checked" (`404`). Conflating these was caught and fixed during development.

**Response**
```json
{
  "package": "left-pad",
  "page": 1,
  "per_page": 20,
  "total": 2,
  "has_more": false,
  "findings": [
    {
      "id": "find_...",
      "package": "left-pad",
      "rule_id": "publisher-transition",
      "rule_version": "v1",
      "created_at": "2026-09-03T09:11:11.000Z",
      "observation_ids": ["obs_..."],
      "evidence": [
        {
          "source": "npm_packument",
          "verification_method": "registry_authoritative_record",
          "confidence_tier": "strong",
          "retrieved_at": "2026-09-03T09:11:10.500Z",
          "raw_reference": "https://registry.npmjs.org/left-pad"
        }
      ],
      "context": "westlac is listed as a current npm maintainer. No provenance attestation exists for this release...",
      "assessment": {
        "verdict": "review_signal",
        "rationale": "Publisher changed and the new release's provenance attestation (if any) does not assert a link to the expected repository.",
        "explicit_non_claim": "This does not establish compromise. Publisher transitions happen routinely for legitimate reasons..."
      }
    }
  ]
}
```

## `GET /findings/:findingId`

A single finding, same shape as one entry above. `404` if not found.

## `GET /health`

Liveness check. `{ "status": "ok" }`.

## Error shape

```json
{ "error": "validation_failed", "details": [ /* zod issue objects */ ] }
{ "error": "not_found", "message": "..." }
{ "error": "internal_error", "message": "Something went wrong processing this request." }
```
