# Deployment Notes

## Render or similar PaaS

Use Node 20+ as a web service with the repository root as root directory. Start command: `npm start`. The source ZIP did not contain a lockfile, and this workspace's package-registry request timed out, so a lockfile was not fabricated. Before production deployment, run `npm install --package-lock-only` in a trusted network-connected environment, review and commit `package-lock.json`, then use `npm ci` as the build command. Until the lockfile exists, `npm ci` will fail; use `npm install` only for a temporary development/staging install. Set environment variables through the host dashboard, not committed files.

Health routes: `/` for liveness and `/health` for Discord gateway readiness. Provide enough shutdown grace time for persistence and resource cleanup. Avoid memory-based ephemeral deployment as the only persistence layer; MongoDB is required for durable application state.

## Separate console deployment

Deploy the contents of the `Helium-Website` repository as a static site. Edit `api-config.js` so `window.HELIUM_API_BASE_URL` points to the backend URL plus `/dashboard`, for example `https://YOUR-API-HOST/dashboard`. Add the exact site origin to `HELIUM_CONSOLE_ORIGINS`. Register Google and Discord callback URLs against the backend domain. For cross-site frontend/backend hosts, use secure SameSite=None cookies.

## Rollout recommendation

Deploy into staging first. Back up MongoDB, run migration previews against a representative database, confirm the preview count, execute one narrow migration, inspect snapshots, and test rollback. Then run auth, cross-guild authorization, CSRF, file path/symlink, attachment permission and model safety integration tests before enabling staff roles or high-risk administration capabilities.
