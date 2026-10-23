# Deployment Setup

Use `README.md` for the supported architecture and `.env.example` as the environment-variable template. The following checklist is intended for deployment review, not a guarantee of production readiness.

## Before first boot

- [ ] Use Node.js 20+ and install the exact dependencies from the reviewed lockfile.
- [ ] Configure `DISCORD_BOT_TOKEN`, `MONGODB_URI`, and Google GenAI credentials.
- [ ] Set at least one valid owner identity (`HELIUM_OWNER_EMAIL` or `HELIUM_OWNER_DISCORD_ID`).
- [ ] Register exact Google and Discord OAuth callback URLs and store client secrets only in environment secrets.
- [ ] Set `HELIUM_CONSOLE_ORIGINS` to the exact deployed frontend origins.
- [ ] Configure reCAPTCHA v3 site/secret keys and `HELIUM_CONSOLE_HOSTNAMES` for the exact console hostname; production OAuth fails closed if CAPTCHA setup is incomplete.
- [ ] Keep admin terminals and file editing disabled.
- [ ] Keep Redis disabled unless a multi-instance deployment requires distributed rate limits.
- [ ] Run `npm run check` and `npm test`.
- [ ] Verify authentication, CSRF rejection, role isolation, migration preview/rollback, and attachment default-deny in a staging environment.
- [ ] Confirm database backups and a tested restore procedure.

## Health and paths

- `GET /` — liveness information.
- `GET /health` — Discord gateway/degraded health.
- `/dashboard/auth/google` and `/dashboard/auth/discord` — configured OAuth starts.
- `/dashboard/api/...` — administrative APIs; all API routes require authentication.

The console UI is a separate project. Set `HELIUM_CONSOLE_URL` to the external UI URL and `HELIUM_CONSOLE_ORIGINS` to the UI's exact origin(s). Its local `api-config.js` must point `window.HELIUM_API_BASE_URL` at the backend's `/dashboard` base URL.

## Production caveats

Sessions are currently process-local, so multiple backend instances will not share sessions without a future shared session store or sticky routing. Redis, if enabled, currently shares rate-limit counters only; it is not a session store or memory service. Complete multi-instance support requires durable shared sessions, distributed role/config state consistency, deployment-aware health checks, and integration/load testing.
