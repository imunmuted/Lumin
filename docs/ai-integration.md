# AI Integration Contract

## Runtime and model selection

The backend uses `@google/genai` and a single registry in `modules/config.js`. Console model changes are validated by `helium/runtimeRegistry.js`; message processing and retry code consult the same model metadata. API: `GET /dashboard/api/cmd/models`, `POST /dashboard/api/cmd/set-model`, and `GET/PUT /dashboard/api/ai/config`.

The registry currently declares these model IDs (verify availability, access and quotas for the deployed Google project before release):

| Display name | API model ID | Tools | Built-in Google tools | Safety controls |
|---|---|---:|---:|---:|
| Gemini 4 Argon | `gemini-4-argon` | Yes | Yes | Where supported |
| Gemini 3.8 Flash | `gemini-3.8-flash` | Yes | Yes | Where supported |
| Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | Yes | Yes | Where supported |
| Gemma 4 26B A4B IT | `gemma-4-26b-a4b-it` | Custom function calls | No | Not exposed by the current adapter |
| Gemma 4 31B IT | `gemma-4-31b-it` | Custom function calls | No | Not exposed by the current adapter |

The keys `gemma-4-26b` and `gemma-4-31b` are internal aliases; the registry values above are the actual API IDs. The default model is Gemini 3.5 Flash-Lite. The fallback chain is explicit and limited to registered IDs. Do not rely on an unverified ID or assume two model families accept identical request fields.

## Prompt and safety behavior

System instructions and personality prompts are runtime-configurable separately from chat history. The runtime registry validates prompt size, model IDs, safety category names and thresholds. The balanced default applies `BLOCK_MEDIUM_AND_ABOVE` for the categories exposed by the installed SDK; model capability metadata prevents the application from claiming a safety override is applied when the selected model does not expose that control.

Safety thresholds are configuration controls, not a guarantee that model output is harmless. The API must retain provider-specific errors and capability metadata so the website can display unsupported settings rather than silently accepting them. Supported categories are detected from the installed SDK, including harassment, hate speech, sexually explicit content, dangerous content, civic integrity and jailbreak where the SDK exposes the corresponding enums.

Official references to verify at release time:

- [Gemini API model catalogue](https://ai.google.dev/gemini-api/docs/models)
- [Function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Safety settings](https://ai.google.dev/gemini-api/docs/safety-settings)
- [Google Gen AI SDK for JavaScript](https://github.com/googleapis/js-genai)

## Context and media

History persists to MongoDB, while each normal conversation request sends no more than five stored, provider-valid historical text messages. System instructions are separate. The current incoming prompt is passed separately. Replies and forwarded-message text are extracted by the existing pipeline. Binary attachments are not processed unless central feature flags allow their type **and** the user has an explicit attachment grant or is listed in `HELIUM_ATTACHMENT_ALLOWLIST`.

## Verification status

The JavaScript syntax and pure security/history tests run without installed provider packages. This source workspace could not reach the npm registry, so SDK imports and real calls have not been verified here. Before release, install dependencies using the reviewed lockfile, test every registered model against the exact configured SDK/API, and verify built-in tools, custom function calls, retry behavior, safety thresholds, attachment handling and provider error cases.
