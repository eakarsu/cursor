# Auth, Billing, Cloud Sync — what's missing and why

These features cannot be built as a local extension. They each require hosted backend services and accounts that don't exist:

## 1. Auth
**Needs:** Identity provider (Auth0, WorkOS, or in-house), OAuth flows for GitHub/Google, token storage, refresh.
**Local stub today:** `aiAssistant.apiKey` setting and `ANTHROPIC_API_KEY` env var. The user supplies their own model API keys directly.
**To productionize:** Stand up `auth.aicode.dev` running Auth0 or similar; add `aiAssistant.signIn` command that opens a browser flow; store tokens with `vscode.SecretStorage`.

## 2. Billing & Usage Limits
**Needs:** Stripe (or equivalent) integration, a metering service that counts tokens per user per request, a quota check on every model call, a webhook for plan changes.
**Local stub today:** None — every request hits the user's own Anthropic/OpenAI key, so usage limits are enforced by the provider's billing.
**To productionize:** Proxy all model calls through `api.aicode.dev/v1/messages`. Each call: validate auth token → check user plan/quota → forward to provider → meter tokens → bill.

## 3. Cloud Sync
**Needs:** A sync service (settings, chat history, project memory, rules across devices).
**Local stub today:** Settings already sync via VS Code's built-in Settings Sync (GitHub/Microsoft account). Chat history is in-memory only.
**To productionize:** Persist `chat.history`, `.aicode/memory.md`, and `.aicode/rules.md` to a per-user cloud store; reconcile on startup.

## 4. Background / Cloud Workspaces
**Needs:** Hosted dev container service (Codespaces-equivalent), agent runner pool, repo cloning, secrets, sandboxed execution.
**Local stub today:** `aiAssistant.runAgent` runs the agent loop in this VS Code process — local equivalent of "background agent."
**To productionize:** Job queue (Temporal/SQS) → ephemeral container (Fly Machines/Modal) → clone repo → run agent loop → push branch + open PR.

## 5. Custom "Tab" model
Cursor's Tab model is a fine-tuned model trained on edit telemetry (millions of accepted/rejected suggestions). It is not reproducible without:
- A training pipeline (Hugging Face Transformers + a small base like StarCoder or Llama).
- A telemetry corpus — they collected this from real users for years.
- GPU budget for training (H100s for days).

**Local stub today:** `tabPredict.ts` uses Claude Haiku 4.5 with a structured-JSON prompt to predict next edits. It's not Tab-quality but it works without training.

---

If you want any of these built for real, the path is: pick a cloud (Fly/Vercel/AWS) → stand up a small Hono/Fastify service for auth+billing+proxy → swap the extension's direct API calls for calls to that service. Multiple weeks of work even for an MVP.
