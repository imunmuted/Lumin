# Security Architecture and Deployment Checklist

## Identity and permissions

The Owner is resolved only from `HELIUM_OWNER_EMAIL` and/or `HELIUM_OWNER_DISCORD_ID`; the console cannot grant owner status. Admin and Moderator grants use `superior`, `senior` or `junior` levels. Guild-scoped grants are checked against the target guild, and owner-only operations stay owner-only regardless of score. Configure role changes through the restricted role API or an explicitly reviewed environment grant.

## Authentication and browser security

Google and Discord OAuth use fixed callback URLs configured in environment variables, OAuth state stored server-side, a provider-bound state cookie, request timeouts, opaque session IDs and HttpOnly cookies. In production, login start requires a short-lived, single-use CAPTCHA ticket bound to provider, client-IP hash and user-agent hash; verification fails closed when the key or hostname allowlist is missing. Use reCAPTCHA v3 and configure exact console hostnames. Mutating APIs require `X-CSRF-Token`. CORS allows only origins in `HELIUM_CONSOLE_ORIGINS`. Prefer a custom domain with sibling subdomains for the UI and API to avoid third-party-cookie restrictions. Use TLS and `Secure` cookies in production. Session state is in-process in this version; scale-out requires a shared authenticated session design before running multiple replicas.

## High-risk features

- Admin terminals: off by default; enabling them allows owner-level execution and should be limited to a private environment.
- File editor: off by default; owner-only when deliberately enabled, with canonical path and size checks.
- Database mutations, runtime config and migrations: owner-only.
- Attachment analysis: explicit user grant or environment allowlist only.
- Redis: disabled by default and never used for memory; if enabled, only rate-limit counters use it. The local fallback is bounded and may not enforce cluster-wide limits.

## Required before production

- Rotate any credentials that may have been committed or shared; never place real tokens in this repository.
- Pin and audit dependencies using the reviewed lockfile. Run SCA, secret scanning and static security analysis in CI.
- Run integration tests against disposable MongoDB and external OAuth test applications. Verify no fail-open path on auth/CSRF/CAPTCHA config errors.
- Check every API route against an explicit permission matrix, including target-guild extraction for nested routes.
- Validate logs do not contain tokens, secrets, message bodies or sensitive model prompts.
- Add TLS/proxy trust configuration, request timeout/size limits, backup/restore tests and an incident response procedure.
- Benchmark CPU, total RSS, event-loop lag, DB query load and latency under representative concurrency on the real Render plan.

## Audit classification

The initial review identifies areas requiring mitigation and tests; a source-level check does not by itself establish exploitability or prove that all vulnerabilities are fixed. Treat terminal access, dynamic config/file edits, broad database mutations and OAuth/session boundaries as critical attack surfaces.
