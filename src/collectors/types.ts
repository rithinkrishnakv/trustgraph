export type CollectorErrorKind = "rate_limited" | "timeout" | "not_found" | "malformed_response" | "network_error";

export interface CollectorError {
  source: string; // which sub-fetch failed, e.g. "attestation:3.8.2"
  kind: CollectorErrorKind;
  detail: string; // safe, non-sensitive message
}

export type CollectorStatus = "completed" | "failed" | "partial";

export interface RawSource {
  url: string;
  fetchedAt: string;
}

export interface CollectorResult<TEntities> {
  status: CollectorStatus;
  startedAt: string;
  completedAt: string;
  entities: TEntities;
  rawSources: RawSource[];
  errors: CollectorError[];
}

export interface Collector<TInput, TEntities> {
  id: string;
  version: string;
  collect(input: TInput): Promise<CollectorResult<TEntities>>;
}

/**
 * Shared fetch wrapper: applies a timeout, classifies failures into the
 * CollectorErrorKind taxonomy, and -- critically -- treats HTTP 404 as a
 * signal to the caller to interpret, NOT automatically as a failure. Some
 * 404s mean "genuinely absent" (e.g. npm's attestation endpoint on a
 * version with no provenance) and some mean "not found at all" (e.g. the
 * package itself doesn't exist). The caller decides which, because only the
 * caller knows which endpoint this is.
 */
export async function timedFetch(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<{ status: number; json: unknown | null; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    const text = await res.text();
    let json: unknown | null = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null; // caller decides whether a malformed body is an error for its use case
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export function classifyFetchError(err: unknown): CollectorErrorKind {
  if (err instanceof Error) {
    if (err.name === "AbortError") return "timeout";
    if ("cause" in err || err.message.includes("fetch failed")) return "network_error";
  }
  return "network_error";
}
