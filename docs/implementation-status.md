# Helium Implementation Status — First Delivery

## Delivered repositories

- **Helium-Backend** — Discord bot, APIs, model adapters, database boundaries, migrations, security policies and tests.
- **Helium-Website** — separately deployable static website using the backend's `/dashboard` API.

The input source was `Lumin-live.zip`. The old `Revamp` archive was not used as a source of code.

## Implemented in this pass

- Modularized backend repository layout; website assets moved out of backend.
- Shared runtime registry for active model, system prompt, personality, supported safety thresholds and feature flags.
- Registered Gemini 4 Argon, Gemini 3.8 Flash, Gemini 3.5 Flash-Lite, Gemma 4 26B A4B IT and Gemma 4 31B IT IDs/capabilities, with an explicit Gemini fallback chain.
- Persistent message history with at most five stored historical text messages sent to the model; invalid leading assistant turns are discarded for provider-valid context.
- Basic replaceable memory facade; vector indexing/embeddings/cluster retrieval and automatic long-term memory summarization disabled. Existing vector collections are intentionally not deleted.
- Text-first behavior, preserved reply/forwarded-message text extraction, centralized attachment feature switches and explicit attachment grant/allowlist.
- Owner-from-environment model, server-scoped Admin/Moderator levels, route permission policy, owner-only dangerous controls, CSRF checks and bounded API/auth rate limiting.
- Google + Discord OAuth configured through fixed callback URLs; production login requires a short-lived CAPTCHA ticket validated for provider, action, hostname and score.
- Dangerous terminal/file editor capability flags default off; filesystem paths use canonical boundary and symlink checks.
- Redis removed from memory use. It remains an optional distributed rate-limit counter only, disabled unless explicitly enabled.
- Settings migration API with previews, bounded selections, explicit overwrite confirmation, snapshots and compare-and-swap rollback checks; endpoints support `all`, `selected`, `unset-only` and `future-only` scopes/modes.
- Expanded console API including command catalogue and paginated audit log query; machine-readable route manifest is synchronized with 116 non-root Express declarations.
- API compatibility stats fields retained without exposing raw runtime configuration/key counters.
- Added import-resolution and route-manifest consistency checks to `npm run check`.

## Validation run in this workspace

- `npm run check`: **pass** — 83 backend JavaScript files; relative imports resolved; route manifest matches all 116 non-root route declarations.
- `npm test`: **pass** — 9 tests covering context window, legacy history shape, path containment/symlink escape, attachment default-deny, guild authorization and owner-only permissions.
- Website JavaScript syntax check: **pass** — 11 JavaScript files.
- Dependency installation: **not completed** — npm registry access timed out. The original source ZIP did not include `package-lock.json`; no lockfile was fabricated.

## Not yet verified — production blockers

1. Generate/review/commit `package-lock.json` from a trusted network-connected environment. Do not use `npm ci` until that lockfile exists.
2. Install dependencies and perform full runtime import/startup verification; syntax checks alone do not catch all top-level/module-evaluation errors.
3. Run integration tests with a disposable MongoDB, a test Discord application, both OAuth providers and a configured reCAPTCHA v3 site. Migration apply/rollback was not executed against a real database in this workspace.
4. Confirm the listed model IDs are enabled for the deployed Google project and validate actual SDK request payloads, function calls, built-in tools, safety thresholds, retries and fallback transitions. Model availability and model-specific capabilities can change.
5. Conduct external security review and test every API method with every role level, including cross-guild attempts, CSRF, OAuth state/ticket replay, rate limits and disabled terminal/file-editor gates.
6. Define per-data-class retention/export/deletion policy for histories, facts, reminders, attachments, audit logs and old vector records. Existing vector data is left untouched by design.
7. Run load tests on the actual hosting tier, sampling total RSS (not only V8 heap), GC, event-loop delay, DB load, temp disk and queue pressure. The 512 MB target and 20,000-user goal are not certified by the current unit tests.

## Configuration before deployment

Copy `.env.example` to `.env` locally or configure the variables in the hosting platform. Set a real owner email and/or Discord ID, Discord bot token, MongoDB URI, Google GenAI key(s), OAuth app credentials and callback URLs, exact console origins, the matching reCAPTCHA site/secret/hostname values, and secure cookie options. Never commit `.env` or real secrets. Keep admin terminals and source/file editors disabled unless a deliberate security review justifies enabling them.
