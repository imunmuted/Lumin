# API Surface and Console Contract

## Base path

Console API base: `/dashboard`; JSON endpoints are under `/dashboard/api/...`. OAuth routes are under `/dashboard/auth/...`. The UI is deployed independently. All API routes are intended to run through the common authentication, role authorization, rate-limit, CSRF (mutations) and audit middleware. OAuth login starts and the read-only OAuth configuration endpoint are public by design.

## Main capability groups

The existing endpoint handlers are retained for operational visibility, bot info, server/user management, per-server/user settings, reminders, birthdays, presence, announcements, lock-down, API key/model selection, feature flags, usage statistics, chat history, explicit memory facts, runtime/module/base config, database collections/documents, file browse/edit/delete, and terminal WebSockets. Interactive terminals are owner-only and disabled by default. File editing is owner-only and disabled by default.

New or consolidated API groups include:

- `GET /dashboard/api/cmd/models` and `POST /dashboard/api/cmd/set-model` — registered model selection.
- `GET /dashboard/api/ai/config`, `/prompts`, `/safety` and `PUT /dashboard/api/ai/config` — validated prompt/safety controls.
- `GET /dashboard/api/security/roles` and mutations under `/dashboard/api/security/roles` — staff hierarchy and assignments.
- `GET/PUT /dashboard/api/cmd/attachment-grants/:userId` — explicit attachment analysis permission.
- `GET/PUT /dashboard/api/settings/defaults` — defaults for new users/server settings.
- `GET /dashboard/api/migrations/fields`, `GET /dashboard/api/migrations`, `POST /dashboard/api/migrations/preview`, `POST /dashboard/api/migrations`, `GET /dashboard/api/migrations/:migrationId`, and `POST /dashboard/api/migrations/:migrationId/rollback` — migration preview/run/status/history/rollback.

Legacy migration endpoints are retained as compatibility adapters into the same migration runner. All selected ID lists and field sets are validated and bounded. Rollback uses snapshots and avoids overwriting records modified after the migration. The API must always return the exact set of successful, skipped and failed items; clients must not treat a 207 response as total success.

## Route inventory maintenance

This inventory groups capabilities and is not a promise that every current legacy route is equally mature. The machine-readable `api/route-manifest.json` covers every current non-root Express route. `npm run check` verifies that local imports resolve and that the manifest exactly matches the source declarations. Every route still requires separate integration tests for authentication, permission, validation, rate-limit and audit behavior. Any new route must be added to the manifest and permission tests before merge.


Additional console-support endpoints:
- `GET /dashboard/api/cmd/command-catalog` returns a sanitized list of declared slash-command metadata for building the separate UI.
- `GET /dashboard/api/audit/logs?limit=50&offset=0&guildId=...&actor=...&since=...` queries audit events, with a maximum page size of 100 and bounded offset. Access requires elevated sensitive-read authorization; staff grants remain guild-scoped.
- `GET /dashboard/api/stats` returns operational aggregates and compatibility fields but does not expose raw runtime configuration or internal API-key counters.

Unknown API routes are Owner-only by default. New endpoints must be added to the route manifest and receive an explicit authorization-policy decision before staff access is granted.
