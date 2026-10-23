/**
 * @fileoverview Structured Levelled Logger for Lumin v2
 * @module core/Logger
 * @version 2.0.0
 *
 * Replaces ALL raw console.log / console.error calls across the codebase.
 *
 * Features:
 *  - Five log levels: DEBUG | INFO | WARN | ERROR | CRITICAL
 *  - Per-module named loggers:  Logger.get('ApiKeyManager')
 *  - ISO timestamp on every line
 *  - Production mode suppresses DEBUG automatically
 *  - ERROR + CRITICAL lines are mirrored to process.stderr
 *  - Structured metadata objects are JSON-serialised inline
 *  - Optional file sink for ERROR+ (set LOG_FILE env var)
 *
 * Usage:
 *   import { Logger } from '../core/Logger.js';
 *   const log = Logger.get('BotManager');
 *   log.info('Bot started', { guilds: 42 });
 *   log.error('Failed to save state', error);
 */

import fs   from 'fs';
import path from 'path';

// ============================================================================
// LOG LEVEL CONSTANTS
// ============================================================================

/**
 * Numeric log levels — higher = more severe.
 * @readonly
 * @enum {number}
 */
export const LogLevel = Object.freeze({
  DEBUG:    10,
  INFO:     20,
  WARN:     30,
  ERROR:    40,
  CRITICAL: 50,
});

/** Map from numeric level → display label (fixed-width for alignment). */
const LEVEL_LABEL = Object.freeze({
  [LogLevel.DEBUG]:    'DEBUG   ',
  [LogLevel.INFO]:     'INFO    ',
  [LogLevel.WARN]:     'WARN    ',
  [LogLevel.ERROR]:    'ERROR   ',
  [LogLevel.CRITICAL]: 'CRITICAL',
});

/** ANSI colour codes — disabled when NO_COLOR env is set or not a TTY. */
const USE_COLOUR = process.env.NO_COLOR === undefined && process.stdout.isTTY;

const ANSI = Object.freeze({
  RESET:   '\x1b[0m',
  DIM:     '\x1b[2m',
  BOLD:    '\x1b[1m',
  DEBUG:   '\x1b[36m',   // cyan
  INFO:    '\x1b[32m',   // green
  WARN:    '\x1b[33m',   // yellow
  ERROR:   '\x1b[31m',   // red
  CRITICAL:'\x1b[35m',  // magenta
});

const LEVEL_COLOUR = Object.freeze({
  [LogLevel.DEBUG]:    ANSI.DEBUG,
  [LogLevel.INFO]:     ANSI.INFO,
  [LogLevel.WARN]:     ANSI.WARN,
  [LogLevel.ERROR]:    ANSI.ERROR,
  [LogLevel.CRITICAL]: ANSI.CRITICAL,
});

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Minimum level to emit.
 * In production (NODE_ENV=production) DEBUG lines are silenced.
 */
const MIN_LEVEL = process.env.NODE_ENV === 'production'
  ? LogLevel.INFO
  : LogLevel.DEBUG;

/**
 * Optional file path for persistent ERROR+ logs.
 * Set LOG_FILE=/path/to/error.log in environment.
 */
const LOG_FILE_PATH = process.env.LOG_FILE
  ? path.resolve(process.env.LOG_FILE)
  : null;

/** Write stream for the optional file sink (lazy-opened on first write). */
let _fileSink = null;

/**
 * Get (or lazily create) the file write stream.
 * @returns {fs.WriteStream|null}
 */
function getFileSink() {
  if (!LOG_FILE_PATH) return null;
  if (_fileSink) return _fileSink;

  try {
    _fileSink = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a', encoding: 'utf8' });
    _fileSink.on('error', (err) => {
      process.stderr.write(`[Logger] Failed to write to log file: ${err.message}\n`);
      _fileSink = null;
    });
  } catch {
    _fileSink = null;
  }

  return _fileSink;
}

// ============================================================================
// FORMATTING HELPERS
// ============================================================================

/**
 * Safely serialise a metadata value to a compact inline string.
 * Error objects get their message + stack; everything else gets JSON.
 *
 * @param {unknown} meta
 * @returns {string}
 */
function serialiseMeta(meta) {
  if (meta === undefined || meta === null) return '';

  if (meta instanceof Error) {
    const lines = [`${meta.name}: ${meta.message}`];
    if (meta.cause instanceof Error) {
      lines.push(`  caused by: ${meta.cause.name}: ${meta.cause.message}`);
    }
    if (meta.stack) {
      // Only include the first 5 stack frames to keep logs readable
      const frames = meta.stack.split('\n').slice(1, 6).join('\n');
      lines.push(frames);
    }
    return '\n' + lines.join('\n');
  }

  try {
    const json = JSON.stringify(meta, null, 0);
    return json === '{}' ? '' : ` ${json}`;
  } catch {
    return ` [unserializable: ${typeof meta}]`;
  }
}

/**
 * Build the formatted log line.
 *
 * @param {number} level      - LogLevel constant
 * @param {string} module     - Module name
 * @param {string} message    - Log message
 * @param {unknown} [meta]    - Optional structured metadata
 * @param {boolean} coloured  - Whether to add ANSI codes
 * @returns {string}
 */
function formatLine(level, module, message, meta, coloured) {
  const ts    = new Date().toISOString();
  const label = LEVEL_LABEL[level] ?? 'UNKNOWN ';
  const metaStr = serialiseMeta(meta);

  if (coloured) {
    const col   = LEVEL_COLOUR[level] ?? ANSI.RESET;
    const dim   = ANSI.DIM;
    const reset = ANSI.RESET;
    const bold  = ANSI.BOLD;
    return `${dim}${ts}${reset} ${col}${bold}[${label}]${reset} ${dim}[${module}]${reset} ${message}${metaStr}`;
  }

  return `${ts} [${label}] [${module}] ${message}${metaStr}`;
}

// ============================================================================
// MODULE LOGGER
// ============================================================================

/**
 * A named logger bound to a specific module.
 * Obtain via `Logger.get('ModuleName')`.
 *
 * @class ModuleLogger
 */
class ModuleLogger {
  /**
   * @param {string} module - Module / component name shown in every line
   */
  constructor(module) {
    /** @type {string} */
    this.module = module;
  }

  /**
   * Core emit method — all level-specific methods call this.
   *
   * @param {number}  level
   * @param {string}  message
   * @param {unknown} [meta]
   */
  _emit(level, message, meta) {
    if (level < MIN_LEVEL) return;

    const coloured  = formatLine(level, this.module, message, meta, USE_COLOUR);
    const plain     = USE_COLOUR
      ? formatLine(level, this.module, message, meta, false)
      : coloured;

    // Stdout for DEBUG/INFO/WARN, stderr for ERROR/CRITICAL
    if (level >= LogLevel.ERROR) {
      process.stderr.write(coloured + '\n');
    } else {
      process.stdout.write(coloured + '\n');
    }

    // File sink (always plain, no ANSI)
    if (level >= LogLevel.ERROR) {
      const sink = getFileSink();
      if (sink) sink.write(plain + '\n');
    }
  }

  /**
   * DEBUG — verbose internal state, loop counters, cache hits.
   * Suppressed in production.
   * @param {string}  message
   * @param {unknown} [meta]
   */
  debug(message, meta) { this._emit(LogLevel.DEBUG, message, meta); }

  /**
   * INFO — normal lifecycle events (startup, connection, command processed).
   * @param {string}  message
   * @param {unknown} [meta]
   */
  info(message, meta) { this._emit(LogLevel.INFO, message, meta); }

  /**
   * WARN — degraded but recoverable situations (key rotation, fallback model).
   * @param {string}  message
   * @param {unknown} [meta]
   */
  warn(message, meta) { this._emit(LogLevel.WARN, message, meta); }

  /**
   * ERROR — operation failed, user likely impacted, needs investigation.
   * @param {string}  message
   * @param {unknown} [meta]
   */
  error(message, meta) { this._emit(LogLevel.ERROR, message, meta); }

  /**
   * CRITICAL — system-level failure, bot may need restart.
   * @param {string}  message
   * @param {unknown} [meta]
   */
  critical(message, meta) { this._emit(LogLevel.CRITICAL, message, meta); }

  /**
   * Convenience: log an error with its full details in one call.
   * Picks ERROR severity unless the error has its own severity field.
   *
   * @param {string}  context - What was happening when the error occurred
   * @param {unknown} error   - The thrown value (Error or LuminError)
   */
  exception(context, error) {
    const level = error?.severity ?? LogLevel.ERROR;
    this._emit(level, `Exception in ${context}`, error);
  }
}

// ============================================================================
// LOGGER REGISTRY
// ============================================================================

/**
 * Global logger registry.
 * Callers should only interact with this namespace object,
 * never instantiate ModuleLogger directly.
 *
 * @namespace Logger
 *
 * @example
 * // In any module file:
 * import { Logger } from '../core/Logger.js';
 * const log = Logger.get('ApiKeyManager');
 * log.info('Rotated to Key 2', { oldKey: 1, newKey: 2 });
 * log.warn('Rate limit hit', { model: 'gemini-3.5-flash-lite' });
 * log.exception('saveStateToFile', error);
 */
export const Logger = Object.freeze({
  /** @type {Map<string, ModuleLogger>} */
  _registry: new Map(),

  /**
   * Get a named logger.  Loggers are singletons per module name.
   *
   * @param {string} module - e.g. 'BotManager', 'ApiKeyManager', 'index'
   * @returns {ModuleLogger}
   */
  get(module) {
    if (!this._registry.has(module)) {
      this._registry.set(module, new ModuleLogger(module));
    }
    return this._registry.get(module);
  },

  /**
   * Root-level shortcuts for quick one-off logs without a named module.
   * Prefer Logger.get() in production code.
   */
  debug   (msg, meta) { this.get('root').debug(msg, meta);    },
  info    (msg, meta) { this.get('root').info(msg, meta);     },
  warn    (msg, meta) { this.get('root').warn(msg, meta);     },
  error   (msg, meta) { this.get('root').error(msg, meta);    },
  critical(msg, meta) { this.get('root').critical(msg, meta); },
});
