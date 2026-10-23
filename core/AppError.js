/**
 * @fileoverview Typed Error Class Hierarchy for Lumin v2
 * @module core/AppError
 * @version 2.0.0
 *
 * All errors thrown inside Lumin extend LuminError so that every catch block
 * can make a single isinstance check and get structured information:
 *   - Whether to retry the operation
 *   - What HTTP / API status code triggered it
 *   - How severe it is (for logger routing)
 *   - A safe user-facing message (never raw stack traces to Discord)
 *
 * Usage:
 *   import { RateLimitError, FilePermissionError } from '../core/AppError.js';
 *   throw new RateLimitError('gemini-3.5-flash-lite', 'Key 2');
 */

// ============================================================================
// SEVERITY LEVELS
// ============================================================================

/**
 * Severity levels for structured logging.
 * Higher number = more critical.
 * @readonly
 * @enum {number}
 */
export const Severity = Object.freeze({
  DEBUG:    10,
  INFO:     20,
  WARN:     30,
  ERROR:    40,
  CRITICAL: 50,
});

// ============================================================================
// BASE CLASS
// ============================================================================

/**
 * Base class for all Lumin application errors.
 *
 * @class LuminError
 * @extends Error
 *
 * @property {string}  code        - Machine-readable error code (e.g. 'RATE_LIMIT')
 * @property {boolean} retryable   - True → caller may retry the operation
 * @property {number}  severity    - One of the Severity enum values
 * @property {string}  userMessage - Safe message that can be shown in Discord
 * @property {unknown} [cause]     - Original error that triggered this one
 */
export class LuminError extends Error {
  /**
   * @param {string}  message              - Internal debug message
   * @param {object}  options
   * @param {string}  options.code         - Error code constant
   * @param {boolean} [options.retryable=false]
   * @param {number}  [options.severity=Severity.ERROR]
   * @param {string}  [options.userMessage] - Shown in Discord; defaults to generic
   * @param {unknown} [options.cause]       - Original/wrapped error
   */
  constructor(message, {
    code,
    retryable = false,
    severity = Severity.ERROR,
    userMessage = 'Something went wrong. Please try again.',
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);

    this.name       = this.constructor.name;
    this.code       = code ?? 'LUMIN_ERROR';
    this.retryable  = retryable;
    this.severity   = severity;
    this.userMessage = userMessage;

    // Maintain proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Returns a plain object safe for structured logging.
   * @returns {{ name: string, code: string, message: string, retryable: boolean, severity: number }}
   */
  toJSON() {
    return {
      name:      this.name,
      code:      this.code,
      message:   this.message,
      retryable: this.retryable,
      severity:  this.severity,
    };
  }
}

// ============================================================================
// API / GEMINI ERRORS
// ============================================================================

/**
 * Thrown when a Gemini API key or model hits a rate limit (HTTP 429).
 *
 * Retryable: YES — caller should rotate key/model then retry.
 *
 * @class RateLimitError
 * @extends LuminError
 *
 * @example
 *   throw new RateLimitError('gemini-3.5-flash-lite', 'Key 3');
 */
export class RateLimitError extends LuminError {
  /**
   * @param {string} [modelName='unknown']  - Model that hit the limit
   * @param {string} [keyLabel='unknown']   - Human-readable key identifier
   * @param {unknown} [cause]               - Original API error
   */
  constructor(modelName = 'unknown', keyLabel = 'unknown', cause) {
    super(
      `Rate limit exceeded on model "${modelName}" using ${keyLabel}`,
      {
        code:        'RATE_LIMIT',
        retryable:   true,
        severity:    Severity.WARN,
        userMessage: 'I\'m a bit busy right now — hang tight while I switch gears! 🔄',
        cause,
      },
    );
    this.modelName = modelName;
    this.keyLabel  = keyLabel;
  }
}

/**
 * Thrown when the Gemini File API returns a 403 for a file uploaded under a
 * different API key.  Files are key-scoped — rotating keys will NOT fix this.
 *
 * Retryable: NO — the file must be re-uploaded with the current key.
 *
 * @class FilePermissionError
 * @extends LuminError
 *
 * @example
 *   throw new FilePermissionError(fileUri, 'Key 1');
 */
export class FilePermissionError extends LuminError {
  /**
   * @param {string}  [fileUri='unknown']  - Gemini file URI that was rejected
   * @param {string}  [keyLabel='unknown'] - Key that rejected the request
   * @param {unknown} [cause]
   */
  constructor(fileUri = 'unknown', keyLabel = 'unknown', cause) {
    super(
      `File permission denied for URI "${fileUri}" on ${keyLabel} — re-upload required`,
      {
        code:        'FILE_PERMISSION',
        retryable:   false,
        severity:    Severity.WARN,
        userMessage: 'There was a hiccup processing your file — give it another try!',
        cause,
      },
    );
    this.fileUri  = fileUri;
    this.keyLabel = keyLabel;
  }
}

/**
 * Thrown when all model fallbacks are exhausted or the model returns an
 * empty / malformed response.
 *
 * Retryable: YES (up to caller's attempt budget).
 *
 * @class ModelError
 * @extends LuminError
 */
export class ModelError extends LuminError {
  /**
   * @param {string}  [modelName='unknown'] - Last model attempted
   * @param {string}  [reason='']           - Short reason string
   * @param {unknown} [cause]
   */
  constructor(modelName = 'unknown', reason = '', cause) {
    super(
      `Model error on "${modelName}"${reason ? `: ${reason}` : ''}`,
      {
        code:        'MODEL_ERROR',
        retryable:   true,
        severity:    Severity.ERROR,
        userMessage: 'I\'m having trouble generating a response right now. Please try again!',
        cause,
      },
    );
    this.modelName = modelName;
  }
}

/**
 * Thrown by the CircuitBreaker when its state is OPEN.
 * Signals that the AI API is currently considered unavailable.
 *
 * Retryable: NO — wait for the circuit to reset.
 *
 * @class CircuitOpenError
 * @extends LuminError
 */
export class CircuitOpenError extends LuminError {
  /**
   * @param {number} [retryAfterMs=30000] - Approximate ms until circuit may close
   * @param {unknown} [cause]
   */
  constructor(retryAfterMs = 30_000, cause) {
    super(
      `Circuit is OPEN — AI API unavailable for ~${Math.round(retryAfterMs / 1000)}s`,
      {
        code:        'CIRCUIT_OPEN',
        retryable:   false,
        severity:    Severity.WARN,
        userMessage: 'The AI service is temporarily unavailable. I\'ll be back shortly! ⚡',
        cause,
      },
    );
    this.retryAfterMs = retryAfterMs;
  }
}

// ============================================================================
// INPUT / VALIDATION ERRORS
// ============================================================================

/**
 * Thrown when user-supplied input fails validation before hitting any API.
 *
 * Retryable: NO — the user must fix their input.
 *
 * @class ValidationError
 * @extends LuminError
 *
 * @example
 *   throw new ValidationError('URL must start with https://', 'Please provide a valid https:// URL.');
 */
export class ValidationError extends LuminError {
  /**
   * @param {string}  internalMessage - Detailed internal description
   * @param {string}  [userMessage]   - Discord-safe message
   * @param {unknown} [cause]
   */
  constructor(internalMessage, userMessage, cause) {
    super(internalMessage, {
      code:        'VALIDATION',
      retryable:   false,
      severity:    Severity.INFO,
      userMessage: userMessage ?? internalMessage,
      cause,
    });
  }
}

/**
 * Thrown when a user lacks the required Discord permissions for an action.
 *
 * Retryable: NO.
 *
 * @class PermissionError
 * @extends LuminError
 */
export class PermissionError extends LuminError {
  /**
   * @param {string}  permissionName  - e.g. 'ManageGuild'
   * @param {unknown} [cause]
   */
  constructor(permissionName, cause) {
    super(
      `Missing permission: ${permissionName}`,
      {
        code:        'PERMISSION_DENIED',
        retryable:   false,
        severity:    Severity.INFO,
        userMessage: `You need the **${permissionName}** permission to do that.`,
        cause,
      },
    );
    this.permissionName = permissionName;
  }
}

// ============================================================================
// DATA / DATABASE ERRORS
// ============================================================================

/**
 * Thrown on MongoDB operation failures.
 *
 * Retryable: YES (transient network / timeout), up to a small attempt limit.
 *
 * @class DatabaseError
 * @extends LuminError
 *
 * @example
 *   throw new DatabaseError('findOne on userSettings', error);
 */
export class DatabaseError extends LuminError {
  /**
   * @param {string}  operation - Description of the DB operation that failed
   * @param {unknown} [cause]   - Original MongoDB error
   */
  constructor(operation, cause) {
    super(
      `Database error during "${operation}"`,
      {
        code:        'DATABASE_ERROR',
        retryable:   true,
        severity:    Severity.ERROR,
        userMessage: 'I had a database hiccup — please try again in a moment.',
        cause,
      },
    );
    this.operation = operation;
  }
}

// ============================================================================
// ATTACHMENT / FILE ERRORS
// ============================================================================

/**
 * Thrown when an attachment cannot be processed (unsupported type, too large,
 * conversion failure, etc.).
 *
 * Retryable: NO — the file itself is the problem.
 *
 * @class AttachmentError
 * @extends LuminError
 */
export class AttachmentError extends LuminError {
  /**
   * @param {string}  fileName    - Original file name for context
   * @param {string}  reason      - Short reason string
   * @param {string}  [userMessage]
   * @param {unknown} [cause]
   */
  constructor(fileName, reason, userMessage, cause) {
    super(
      `Attachment error for "${fileName}": ${reason}`,
      {
        code:        'ATTACHMENT_ERROR',
        retryable:   false,
        severity:    Severity.WARN,
        userMessage: userMessage ?? `I couldn't process **${fileName}** — ${reason}`,
        cause,
      },
    );
    this.fileName = fileName;
  }
}

// ============================================================================
// UTILITY: Error classification from raw API errors
// ============================================================================

/**
 * Inspects a raw (non-LuminError) exception and converts it to the appropriate
 * LuminError subclass.  Use this at the boundary between external APIs and
 * internal code so that all downstream error handling can use typed checks.
 *
 * @param {unknown} rawError       - The original thrown value
 * @param {string}  [modelName=''] - Current model name for context
 * @param {string}  [keyLabel='']  - Current key label for context
 * @param {string}  [fileUri='']   - File URI if relevant
 * @returns {LuminError}           - Typed Lumin error
 *
 * @example
 *   try {
 *     await genAI.models.generateContent(request);
 *   } catch (err) {
 *     throw classifyApiError(err, 'gemini-3.5-flash-lite', 'Key 1');
 *   }
 */
export function classifyApiError(rawError, modelName = '', keyLabel = '', fileUri = '') {
  // Already classified — pass through
  if (rawError instanceof LuminError) return rawError;

  const msg    = rawError?.message ?? String(rawError);
  const status = rawError?.status ?? rawError?.code ?? 0;

  // ── Rate limit ──────────────────────────────────────────────────────────────
  const isRateLimit =
    status === 429 ||
    msg.includes('429') ||
    msg.includes('RESOURCE_EXHAUSTED') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rateLimitExceeded');

  if (isRateLimit) return new RateLimitError(modelName, keyLabel, rawError);

  // ── File permission (key-scoped files) ────────────────────────────────────
  const isFilePerm =
    (status === 403 || msg.includes('403')) &&
    (msg.includes('File') || msg.includes('file') || msg.includes('PERMISSION_DENIED'));

  if (isFilePerm) return new FilePermissionError(fileUri, keyLabel, rawError);

  // ── Network / transient API errors ────────────────────────────────────────
  const isTransient =
    status === 500 ||
    status === 502 ||
    status === 503 ||
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('timeout') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT');

  if (isTransient) return new ModelError(modelName, 'transient API error', rawError);

  // ── Local JS bugs — do NOT retry ──────────────────────────────────────────
  // If there's no HTTP status or code it's a local programming error.
  const isApiError = Boolean(
    rawError?.status ||
    rawError?.code ||
    isTransient,
  );

  if (!isApiError) {
    // Wrap but mark non-retryable so retry loops bail out immediately
    const err = new ModelError(modelName, msg, rawError);
    err.retryable = false;
    err.severity  = Severity.CRITICAL;
    return err;
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return new ModelError(modelName, msg, rawError);
}

/**
 * Type guard — returns true if the value is any LuminError subclass.
 *
 * @param {unknown} value
 * @returns {value is LuminError}
 */
export function isLuminError(value) {
  return value instanceof LuminError;
}
