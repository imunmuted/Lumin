# Helium Website

This static website is deployed separately from the Helium Discord bot backend. It includes the administrative website for Helium. The Discord bot display name remains independently configurable (default: Lumin).

## Configure and deploy

1. Edit `api-config.js` and set `window.HELIUM_API_BASE_URL` to the public backend URL plus `/dashboard` (for example, `https://api.example.com/dashboard`). This value is public and must not contain secrets.
2. Deploy the repository as a static site. The entry point is `index.html`.
3. Set backend `HELIUM_CONSOLE_URL` to this site URL, and add its exact origin to `HELIUM_CONSOLE_ORIGINS`.
4. Register Google and Discord OAuth callback URLs at the backend endpoints `/dashboard/auth/google/callback` and `/dashboard/auth/discord/callback`.
5. For a truly cross-site deployment, set `HELIUM_COOKIE_SAME_SITE=None` and `HELIUM_COOKIE_SECURE=true` on the backend and use HTTPS for both applications.

The console never stores bearer tokens in local storage. It uses an HttpOnly server session cookie, credentials-enabled API requests, and the CSRF token returned by `/auth/me`. WebSocket URLs are derived from the configured API base. Dangerous terminals should remain disabled by default in the backend.

The static bundle still uses externally hosted Google Fonts and xterm assets. For tightly controlled deployments, vendor these assets locally and add integrity pinning/CSP restrictions appropriate to the deployed build.
