# Completeness Review: cursor

**Review date:** 2026-07-18

## Assessment basis

Static inspection of project-owned source and configuration only; no dependency installation, build, database migration, external-service call, or runtime launch was performed. The scan considered 77 project files (62 source files), 3 manifest(s), 2 test-like file(s), and 0 CI workflow(s), excluding dependency/generated directories.

## Classification

**Broken-inert-unsafe**

This repository should not be treated as a launchable AI/agent platform app. Its checked-in state is inert, internally inconsistent, credential/provenance-sensitive, or unsafe to operate; feature work must wait until the blockers below are repaired and verified.

## Why it is not complete

- The supported build/runtime path and a trustworthy end-to-end workflow have not been demonstrated from the checked-in state.
- The documented purpose and executable source layout are mismatched or rely on missing/obsolete components.

## Needed features

1. Establish provenance/licensing and reproduce a clean build in an isolated environment before adding product surface.
2. Replace generic prompt wrappers with typed domain tools, grounded retrieval, provenance, and schema-validated outputs.
3. Add tenant-scoped connectors, permission-aware indexing, incremental sync, deletion propagation, and source freshness indicators.
4. Implement evaluation datasets, quality/safety gates, cost and latency budgets, tracing, and human approval checkpoints.
5. Run tools in isolated jobs with timeouts, retries, idempotency, rate limits, and auditable input/output records.

## Risks or launch blockers

- AI-provider availability, cost, privacy, prompt injection, and unvalidated output are launch risks until bounded and evaluated.
- No CI evidence prevents broken or insecure changes from reaching a release.

## Evidence inspected

- `server/README.md`
- `codex-custom-viz-and-ops.html:15`
- `server/README.md:37`
- `server/src/auth.ts`
- `vscode/extensions/ai-assistant/test/core.test.js`
- `server/package.json`

## Recommended next action

Quarantine execution, repair provenance/secret/startup/build blockers in an isolated branch, and reassess only after a clean reproducible build and smoke test.

## Implementation progress (2026-07-18)

1. **Partially implemented:** execution is provenance-gated and startup is nondestructive; definitive ownership/license proof and a clean dependency build remain owner-blocked.
2. **Partially implemented:** server-side typed/session/model-proxy boundaries and error handling were hardened; editor-domain grounding, retrieval provenance, and validated tool schemas remain incomplete.
3. **Partially implemented:** tenant-scoped cache/sync/job boundaries were added where local code allowed; real permission-aware connectors, freshness, deletion propagation, and source contracts remain provider-blocked.
4. **Partially implemented:** audit/telemetry and approval boundaries improved; representative evaluation datasets, budgets, thresholds, and measured results remain owner/provider work.
5. **Partially implemented:** job timeout/retry/idempotency controls were hardened locally; true sandboxed tool execution and infrastructure-backed rate/capacity validation remain external.

## Runtime acceptance (2026-07-20)

The independently implemented server passed the non-suite runtime validator on the fresh assigned PostgreSQL/API/UI port triple `55646/6102/6103` (only the API listener was needed): `start.sh` refused implicit/default listeners, selected a Node runtime compatible with the installed SQLite binding, explicitly provisioned a scrypt local acceptance identity, authenticated it, persisted an opaque session digest, and reloaded the user through `/api/auth/me`. The validator recorded `API_VERIFIED — startup_login_session_api` and released all ports. The local password path is disabled in production, so the existing GitHub OAuth flow remains the production identity boundary. The focused login/session test, launcher syntax, package validation, and `git diff --check` passed. The incomplete editor checkout and its unresolved provenance remain outside this server-only runtime result.
