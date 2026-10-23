# Helium Backend Architecture

## Repository boundaries

This repository contains the Discord bot, business logic, database repositories, model integration, shared security policies and API controllers. The website is a separate repository named **Helium** and calls the backend at `/dashboard`. The backend never serves the static console bundle.

## Module boundaries

- `index.js`: process lifecycle, Discord event wiring, HTTP health routes and bot startup.
- `commands/`: slash commands and retained bot features.
- `modules/message/`: message orchestration, prompt construction, model response/tool handling and persistence.
- `modules/functions/`: registered model tools and execution adapters.
- `modules/config.js`: model registry, model capabilities, supported safety settings, queue/resource defaults and feature flags.
- `helium/runtimeRegistry.js`: validated mutable runtime prompt/model/safety configuration. Secret material remains environment-only.
- `managers/StateManager.js`: user/server settings defaults and persistence boundary.
- `database/`: connection, collection and persistence abstractions.
- `security/`: authorization, canonical filesystem path checks and attachment grants.
- `migrations/SettingsMigrationRunner.js`: versioned, previewable settings migrations and guarded rollback.
- `infra/RedisStore.js`: optional distributed security rate-limit counters only; disabled by default.

## Message flow

Discord event → per-user queue → `MessageProcessor` → text/reply/forward extraction → attachment permission gate → prompt assembly → last five persisted text messages as context → registered model selection → AI call/tool calls → response send → history persistence. System and personality prompts are not counted as stored conversation messages.

## Context and memory contract

Chat history is persistent, but only the last five stored messages are sent as historical context for a normal chat response. The current incoming prompt is separately passed to the model. The compatibility memory facade intentionally avoids vector indexing, cluster construction and autonomous long-term retrieval. User-requested stored facts and existing explicit bot features use bounded APIs and are not injected into ordinary prompts automatically. This keeps the future memory implementation behind a replaceable module boundary.

## Scalability boundaries

A bounded queue is used per user. The configured V8 heap cap does not cap native buffers or total RSS. The 512 MB target must be evaluated with RSS sampling, GC pause and latency metrics, database pressure, temporary media files, concurrent API calls, and the target's actual user/message distribution. 20,000 registered users is not equivalent to 20,000 concurrent active users; no throughput guarantee exists without repeatable load tests.
