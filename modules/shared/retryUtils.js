/**
 * @fileoverview Shared Retry Utility with Exponential Backoff + Jitter
 * @module modules/shared/retryUtils
 * @version 2.0.0
 *
 * Single source of truth for all retry logic across Lumin v2.
 * Replaces:
 *   - tools/others.js  retryOperation()         (no backoff, no error classification)
 *   - commands/summary.js  executeWithRetry()   (duplicate, summary-specific)
 *   - modules/messageProcessor.js  inline retry loop  (deeply nested)
 *   - botManager.js  inline retry logic         (scattered across functions)
 *
 * Features:
 *   - Exponential backoff:  delay = min(base * 2^attempt + jitter, maxDelay)
 *   - Per-attempt jitter (0–200 ms) prevents thundering herd
 *   - Error classification via AppError types
 *   - Injectable hooks: onRateLimit, onModelFail, onKeyRotate
 *   - Non-retryable errors bail out immediately (no wasted quota)
 *   - Full structured logging on every attempt
 *
 * @requires core/AppError
 * @requires core/Logger
 */

import { classifyApiError, RateLimitError, FilePermissionError, isLuminError } from '../../core/AppError.js';
import { Logger } from '../../core/Logger.js';

const log = Logger.get('retryUtils');

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default retry configuration values. */
const DEFAULTS = Object.freeze({
  maxAttempts:    3,
  initialDelayMs: 1_000,
  maxDelayMs:     16_000,
  jitterMs:       200,
});

// ============================================================================
// TYPES (JSDoc only — no runtime overhead)
// ============================================================================

/**
 * @typedef {object} RetryOptions
 *
 * @property {number}   [maxAttempts=3]
 *   Total number of attempts (1 = no retry).
 *
 * @property {number}   [initialDelayMs=1000]
 *   Base delay for the first retry in milliseconds.
 *
 * @property {number}   [maxDelayMs=16000]
 *   Hard cap on backoff delay.
 *
 * @property {number}   [jitterMs=200]
 *   Maximum random jitter added to each delay.
 *
 * @property {string}   [modelName='']
 *   Current model name — passed to classifyApiError for richer errors.
 *
 * @property {string}   [keyLabel='']
 *   Current key label — passed to classifyApiError.
 *
 * @property {string}   [fileUri='']
 *   File URI if relevant — passed to classifyApiError.
 *
 * @property {(error: RateLimitError) => Promise<void>} [onRateLimit]
 *   Hook called when a RateLimitError is classified.
 *   Use this to trigger key/model rotation in ApiKeyManager.
 *   Awaited before the next retry.
 *
 * @property {(error: import('../../core/AppError.js').ModelError) => Promise<void>} [onModelFail]
 *   Hook called on ModelError.
 *   Use this to advance the model fallback chain.
 *
 * @property {() => Promise<void>} [onFilePermission]
 *   Hook called on FilePermissionError.
 *   Use this to re-upload files with the new key.
 *   If omitted, FilePermissionError is rethrown immediately.
 *
 * @property {(attempt: number, error: unknown, delayMs: number) => void} [onRetry]
 *   Optional callback invoked just before sleeping for the next retry.
 *   Useful for updating typing indicators etc.
 */

// ============================================================================
// DELAY HELPER
// ============================================================================

/**
 * Calculate the next backoff delay with full jitter.
 *
 * Formula: min(initialDelayMs * 2^attempt + random(0, jitterMs), maxDelayMs)
 *
 * @param {number} attempt       - Zero-based attempt index (0 = first retry)
 * @param {number} initialDelayMs
 * @param {number} maxDelayMs
 * @param {number} jitterMs
 * @returns {number} Delay in milliseconds
 */
function calcBackoff(attempt, initialDelayMs, maxDelayMs, jitterMs) {
  const exponential = initialDelayMs * Math.pow(2, attempt);
  const jitter      = Math.random() * jitterMs;
  return Math.min(exponential + jitter, maxDelayMs);
}

/**
 * Await a delay.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// MAIN EXPORT
// ============================================================================

/**
 * Execute an async function with automatic retry, exponential backoff, and
 * structured error classification.
 *
 * Two-layer contract:
 *   - Layer 1 (this function): classifies errors, decides retry/rotate/bail.
 *   - Layer 2 (caller): wraps this in its own try/catch to send user-facing embeds.
 *
 * @template T
 * @param {() => Promise<T>}  fn       - Async function to execute and retry
 * @param {RetryOptions}      [opts]   - Retry configuration and hooks
 * @returns {Promise<T>}               - Resolved value on success
 * @throws {import('../../core/AppError.js').LuminError} On exhausted retries or non-retryable error
 *
 * @example
 * // Basic usage (messageProcessor)
 * const result = await executeWithRetry(
 *   () => genAI.models.generateContent(request),
 *   {
 *     maxAttempts: 3,
 *     modelName:   'gemini-3.5-flash-lite',
 *     keyLabel:    'Key 1',
 *     onRateLimit: (err) => apiKeyManager.switchToNextKeyOrModel(err),
 *   }
 * );
 *
 * @example
 * // With file re-upload hook (summary command)
 * const result = await executeWithRetry(
 *   () => genAI.models.generateContent(request),
 *   {
 *     maxAttempts:     3,
 *     onFilePermission: async () => { fileUri = await reuploadFile(); },
 *   }
 * );
 */
export async function executeWithRetry(fn, opts = {}) {
  const {
    maxAttempts    = DEFAULTS.maxAttempts,
    initialDelayMs = DEFAULTS.initialDelayMs,
    maxDelayMs     = DEFAULTS.maxDelayMs,
    jitterMs       = DEFAULTS.jitterMs,
    modelName      = '',
    keyLabel       = '',
    fileUri        = '',
    onRateLimit,
    onModelFail,
    onFilePermission,
    onRetry,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      log.debug(`Attempt ${attempt + 1}/${maxAttempts}`, { modelName, keyLabel });
      const result = await fn();
      if (attempt > 0) {
        log.info(`Succeeded on attempt ${attempt + 1}`, { modelName });
      }
      return result;

    } catch (raw) {
      // Classify the raw error into a typed LuminError
      const error = classifyApiError(raw, modelName, keyLabel, fileUri);
      lastError   = error;

      const isLastAttempt = attempt === maxAttempts - 1;

      log.warn(`Attempt ${attempt + 1}/${maxAttempts} failed`, {
        code:      error.code,
        message:   error.message,
        retryable: error.retryable,
      });

      // ── Non-retryable: bail immediately, no delay ────────────────────────
      if (!error.retryable) {
        // Special case: FilePermissionError CAN be recovered if a re-upload
        // hook is provided — treat it as retryable in that scenario.
        if (error instanceof FilePermissionError && onFilePermission) {
          log.info('FilePermissionError — invoking re-upload hook', { fileUri });
          try {
            await onFilePermission(error);
          } catch (hookErr) {
            log.error('onFilePermission hook failed', hookErr);
            throw error; // give up
          }
          // Continue to next attempt with (presumably) updated fileUri
          continue;
        }

        log.error(`Non-retryable error — aborting immediately`, { code: error.code });
        throw error;
      }

      // ── Rate limit: invoke rotation hook ────────────────────────────────
      if (error instanceof RateLimitError && onRateLimit) {
        log.info('RateLimitError — invoking key/model rotation hook');
        try {
          await onRateLimit(error);
        } catch (hookErr) {
          log.error('onRateLimit hook failed', hookErr);
        }
      }

      // ── Model error: invoke model-fallback hook ──────────────────────────
      if (!isLastAttempt && onModelFail && !(error instanceof RateLimitError)) {
        try {
          await onModelFail(error);
        } catch (hookErr) {
          log.error('onModelFail hook failed', hookErr);
        }
      }

      // ── Last attempt: throw without sleeping ────────────────────────────
      if (isLastAttempt) {
        log.error(`All ${maxAttempts} attempts exhausted`, { code: error.code });
        throw error;
      }

      // ── Calculate delay and sleep ────────────────────────────────────────
      const delayMs = calcBackoff(attempt, initialDelayMs, maxDelayMs, jitterMs);
      log.debug(`Waiting ${Math.round(delayMs)}ms before next attempt`);

      if (onRetry) onRetry(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }

  // Should never reach here, but TypeScript / JSDoc completeness:
  throw lastError ?? new Error('executeWithRetry: unexpected exit');
}

/**
 * Simplified retry wrapper for database operations.
 * Uses tighter defaults (fewer attempts, shorter delays) since DB errors
 * are usually transient network blips, not quota issues.
 *
 * @template T
 * @param {() => Promise<T>}  fn        - DB operation to retry
 * @param {string}            [context] - Description for logging
 * @param {number}            [maxAttempts=3]
 * @returns {Promise<T>}
 * @throws {import('../../core/AppError.js').DatabaseError}
 *
 * @example
 * const user = await retryDb(
 *   () => collection.findOne({ userId }),
 *   'getUserSettings'
 * );
 */
export async function retryDb(fn, context = 'db operation', maxAttempts = 3) {
  return executeWithRetry(fn, {
    maxAttempts,
    initialDelayMs: 500,
    maxDelayMs:     4_000,
    jitterMs:       100,
    modelName:      context,
  });
}
