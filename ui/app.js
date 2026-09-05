const form = document.getElementById("scan-form");
const input = document.getElementById("package-input");
const button = document.getElementById("scan-button");
const statusEl = document.getElementById("scan-status");
const results = document.getElementById("results");

const TIER_LABEL = { strong: "strong", moderate: "moderate", weak: "weak / unverified" };
const VERDICT_LABEL = {
  review_signal: "review signal",
  informational: "informational",
  unable_to_verify: "unable to verify",
};

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pkg = input.value.trim();
  if (!pkg) return;
  await runScanAndRender(pkg);
});

async function runScanAndRender(pkg) {
  button.disabled = true;
  statusEl.textContent = `Scanning ${pkg}…`;
  statusEl.classList.remove("error");
  results.innerHTML = "";

  try {
    const scanRes = await fetch("/api/v1/scans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ package: pkg }),
    });
    const scanBody = await scanRes.json();

    if (!scanRes.ok) {
      statusEl.textContent = describeScanError(scanBody);
      statusEl.classList.add("error");
      return;
    }

    statusEl.textContent = describeScanOutcome(scanBody);

    const findingsRes = await fetch(`/api/v1/packages/${encodeURIComponent(pkg)}/findings?per_page=50`);
    const findingsBody = await findingsRes.json();
    renderPackage(pkg, scanBody, findingsBody);
  } catch (err) {
    statusEl.textContent = "Could not reach the TrustGraph API. Is the server running?";
    statusEl.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

function describeScanOutcome(scan) {
  if (scan.reused_existing_scan) {
    return `Showing a recent scan (reused — completed ${relativeTime(scan.completed_at)}).`;
  }
  if (scan.status === "completed_partial") {
    return "Scan completed with some sources unavailable — see note below.";
  }
  return "Scan completed.";
}

function describeScanError(body) {
  if (body?.error === "validation_failed") return "That doesn't look like a valid npm package name.";
  return "This package could not be scanned. It may not exist on the npm registry.";
}

function relativeTime(iso) {
  if (!iso) return "just now";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "moments ago";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} hr ago`;
}

function renderPackage(pkg, scan, findingsBody) {
  const container = document.createElement("div");

  const summary = document.createElement("div");
  summary.className = "package-summary";
  summary.innerHTML = `<code>${escapeHtml(pkg)}</code> — ${findingsBody.total} finding${findingsBody.total === 1 ? "" : "s"} on record.`;

  if (scan.collector_results?.github !== "ok") {
    const note = document.createElement("div");
    note.className = "collector-note";
    note.textContent =
      scan.collector_results?.github === "skipped"
        ? "GitHub repository data was not applicable for this scan (no linked repository, or nothing to check)."
        : "GitHub repository data was unavailable for this scan. Findings below reflect npm-side evidence only — this is not the same as GitHub having confirmed nothing unusual.";
    summary.appendChild(note);
  }
  container.appendChild(summary);

  if (findingsBody.findings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<strong>No findings.</strong> No publisher transition, provenance regression, or repository change was detected across this package's version history. This does not mean the package has been fully verified — it means nothing in scope changed.`;
    container.appendChild(empty);
  } else {
    for (const finding of findingsBody.findings) {
      container.appendChild(renderFinding(finding));
    }
  }

  results.innerHTML = "";
  results.appendChild(container);
}

function renderFinding(finding) {
  const el = document.createElement("article");
  el.className = "finding";

  const header = document.createElement("div");
  header.className = "finding-header";
  header.innerHTML = `
    <span class="finding-rule">${escapeHtml(finding.rule_id)}@${escapeHtml(finding.rule_version)}</span>
    <span class="verdict-tag verdict-${finding.assessment?.verdict}">${escapeHtml(VERDICT_LABEL[finding.assessment?.verdict] ?? finding.assessment?.verdict ?? "unknown")}</span>
  `;
  el.appendChild(header);

  // Zone 1: Assessment (what TrustGraph concludes, stated first so the
  // reader has the headline, then can check the evidence behind it)
  if (finding.assessment) {
    const section = document.createElement("div");
    section.className = "finding-section";
    section.innerHTML = `
      <h3>assessment</h3>
      <p class="assessment-rationale">${escapeHtml(finding.assessment.rationale)}</p>
      <p class="non-claim">${escapeHtml(finding.assessment.explicit_non_claim)}</p>
    `;
    el.appendChild(section);
  }

  // Zone 2: Context
  if (finding.context) {
    const section = document.createElement("div");
    section.className = "finding-section";
    section.innerHTML = `<h3>context</h3><p class="context-note">${escapeHtml(finding.context)}</p>`;
    el.appendChild(section);
  }

  // Zone 3: Evidence -- tier stated in both word and color, never a bare icon
  if (finding.evidence?.length) {
    const section = document.createElement("div");
    section.className = "finding-section";
    const heading = document.createElement("h3");
    heading.textContent = "evidence";
    section.appendChild(heading);

    const list = document.createElement("ul");
    list.className = "evidence-list";
    for (const ev of finding.evidence) {
      const li = document.createElement("li");
      li.className = "evidence-row";
      li.dataset.tier = ev.confidence_tier;
      li.innerHTML = `
        <span class="evidence-tier-label">${escapeHtml(TIER_LABEL[ev.confidence_tier] ?? ev.confidence_tier)}</span>
        <span class="evidence-detail">${escapeHtml(describeSource(ev.source))} — <code>${escapeHtml(ev.raw_reference)}</code></span>
      `;
      list.appendChild(li);
    }
    section.appendChild(list);
    el.appendChild(section);
  }

  return el;
}

function describeSource(source) {
  const map = {
    npm_packument: "npm registry record",
    npm_attestation_api: "npm provenance attestation",
    github_attestations_api: "GitHub artifact attestation",
    github_contributors_api: "GitHub commit history",
    github_repo_api: "GitHub repository metadata",
    npm_profile_self_reported: "npm profile (self-reported)",
  };
  return map[source] ?? source;
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = String(s ?? "");
  return div.innerHTML;
}
