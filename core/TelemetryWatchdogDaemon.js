/**
 * @fileoverview Telemetry and Memory Watchdog Daemon for Project Helium.
 *
 * Designed specifically for Render Free Tier environments (512MB RAM ceiling,
 * single shared 0.1 vCPU). Monitors RSS, heap fragmentation, event loop latency,
 * and proactively triggers garbage collection and emergency memory pruning before
 * the OS OOM killer terminates the process.
 *
 * Mathematical Foundations:
 *   1. Heap Fragmentation Ratio:
 *      \Phi = 1 - \frac{\text{heapUsed}}{\text{heapTotal}}
 *      When \Phi > 0.45 under elevated heap usage, V8 is retaining uncompacted memory.
 *   2. Memory Pressure Ratio:
 *      \mathcal{M} = \frac{\text{rss}}{\text{limit}_{\text{RAM}}}
 *      - \mathcal{M} < 0.70: NORMAL
 *      - 0.70 \le \mathcal{M} < 0.85: ELEVATED (triggers proactive GC if available)
 *      - \mathcal{M} \ge 0.85: CRITICAL (invokes emergency cache eviction hooks + aggressive GC)
 *   3. Event Loop Delay (\Delta t_{\text{lag}}):
 *      Measured via high-resolution performance timers:
 *      \Delta t_{\text{lag}} = t_{\text{actual}} - t_{\text{expected}}
 *
 * @module core/TelemetryWatchdogDaemon
 * @version 4.0.0-helium
 */

import { performance } from 'perf_hooks';
import { Logger } from './Logger.js';

const logger = Logger.get('TelemetryWatchdog');

/**
 * Pressure states for system memory and event loop.
 * @readonly
 * @enum {string}
 */
export const MemoryPressureState = Object.freeze({
  NORMAL:   'NORMAL',
  ELEVATED: 'ELEVATED',
  CRITICAL: 'CRITICAL',
});

export class TelemetryWatchdogDaemon {
  /**
   * @param {object} [options={}]
   * @param {number} [options.renderRamLimitMb=512] - Absolute RAM cap (default 512 for Render)
   * @param {number} [options.sampleIntervalMs=30000] - Sample frequency (default 30s)
   * @param {number} [options.elevatedThresholdRatio=0.70] - 70% = 358MB
   * @param {number} [options.criticalThresholdRatio=0.85] - 85% = 435MB
   */
  constructor(options = {}) {
    this.renderRamLimitMb = Number(process.env.RENDER_RAM_LIMIT_MB) || options.renderRamLimitMb || 512;
    this.sampleIntervalMs = options.sampleIntervalMs || 30000;
    this.elevatedThresholdRatio = options.elevatedThresholdRatio || 0.70;
    this.criticalThresholdRatio = options.criticalThresholdRatio || 0.85;

    /** @type {NodeJS.Timeout|null} */
    this._intervalTimer = null;
    /** @type {Array<() => Promise<void>|void>} */
    this._emergencyEvictionHooks = [];

    this._state = MemoryPressureState.NORMAL;
    this._lastCheckTimestamp = Date.now();
    this._consecutiveCriticalCount = 0;
    this._totalGcTriggered = 0;
    this._eventLoopLagMs = 0;
  }

  /**
   * Register a callback to be executed when memory pressure enters CRITICAL state.
   * Typically used by caches to flush volatile buffers.
   * @param {() => Promise<void>|void} callback
   */
  registerEmergencyEvictionHook(callback) {
    if (typeof callback === 'function') {
      this._emergencyEvictionHooks.push(callback);
    }
  }

  /**
   * Unregister an eviction callback.
   * @param {() => Promise<void>|void} callback
   */
  unregisterEmergencyEvictionHook(callback) {
    this._emergencyEvictionHooks = this._emergencyEvictionHooks.filter(cb => cb !== callback);
  }

  /**
   * Start the watchdog daemon interval loop.
   */
  start() {
    if (this._intervalTimer) return;

    logger.info('Starting Telemetry Watchdog Daemon', {
      ramLimitMb: this.renderRamLimitMb,
      sampleIntervalMs: this.sampleIntervalMs,
      elevatedAtMb: Math.round(this.renderRamLimitMb * this.elevatedThresholdRatio),
      criticalAtMb: Math.round(this.renderRamLimitMb * this.criticalThresholdRatio),
      gcExposed: typeof global.gc === 'function'
    });

    this._intervalTimer = setInterval(() => {
      this.evaluateTelemetry().catch(err => {
        logger.error('Watchdog cycle evaluation failed', err);
      });
    }, this.sampleIntervalMs);

    // Unref timer so it does not block clean process shutdown
    if (typeof this._intervalTimer.unref === 'function') {
      this._intervalTimer.unref();
    }
  }

  /**
   * Stop the watchdog daemon.
   */
  stop() {
    if (this._intervalTimer) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
      logger.info('Stopped Telemetry Watchdog Daemon');
    }
  }

  /**
   * Measure instantaneous event loop delay.
   * @returns {Promise<number>} Lag in milliseconds
   */
  measureEventLoopLag() {
    return new Promise(resolve => {
      const start = performance.now();
      setImmediate(() => {
        const delta = performance.now() - start;
        this._eventLoopLagMs = Math.max(0, delta);
        resolve(this._eventLoopLagMs);
      });
    });
  }

  /**
   * Gather complete telemetry snapshot.
   * @returns {object} Telemetry statistics
   */
  getTelemetry() {
    const mem = process.memoryUsage();
    const rssMb = mem.rss / (1024 * 1024);
    const heapTotalMb = mem.heapTotal / (1024 * 1024);
    const heapUsedMb = mem.heapUsed / (1024 * 1024);
    const externalMb = mem.external / (1024 * 1024);
    const arrayBuffersMb = (mem.arrayBuffers || 0) / (1024 * 1024);

    const pressureRatio = rssMb / this.renderRamLimitMb;
    const fragmentationRatio = heapTotalMb > 0 ? (1 - (heapUsedMb / heapTotalMb)) : 0;

    return {
      timestamp: Date.now(),
      pressureState: this._state,
      pressureRatio: Number(pressureRatio.toFixed(4)),
      rssMb: Number(rssMb.toFixed(2)),
      heapTotalMb: Number(heapTotalMb.toFixed(2)),
      heapUsedMb: Number(heapUsedMb.toFixed(2)),
      externalMb: Number(externalMb.toFixed(2)),
      arrayBuffersMb: Number(arrayBuffersMb.toFixed(2)),
      fragmentationRatio: Number(fragmentationRatio.toFixed(4)),
      eventLoopLagMs: Number(this._eventLoopLagMs.toFixed(2)),
      gcTriggerCount: this._totalGcTriggered
    };
  }

  /**
   * Perform a single evaluation cycle:
   * 1. Check memory usage against thresholds.
   * 2. Measure event loop latency.
   3. Trigger GC or emergency eviction if thresholds are breached.
   */
  async evaluateTelemetry() {
    await this.measureEventLoopLag();
    const telemetry = this.getTelemetry();
    this._lastCheckTimestamp = Date.now();

    const elevatedLimitMb = this.renderRamLimitMb * this.elevatedThresholdRatio;
    const criticalLimitMb = this.renderRamLimitMb * this.criticalThresholdRatio;

    if (telemetry.rssMb >= criticalLimitMb) {
      this._state = MemoryPressureState.CRITICAL;
      this._consecutiveCriticalCount++;

      logger.warn('CRITICAL Memory Pressure detected on Render Free Tier', {
        rssMb: telemetry.rssMb,
        criticalLimitMb: Math.round(criticalLimitMb),
        pressureRatio: `${(telemetry.pressureRatio * 100).toFixed(1)}%`,
        consecutiveCycles: this._consecutiveCriticalCount
      });

      await this.triggerEmergencyPrune();
      this.triggerGarbageCollection('critical_memory_pressure');
    } else if (telemetry.rssMb >= elevatedLimitMb) {
      this._state = MemoryPressureState.ELEVATED;
      this._consecutiveCriticalCount = 0;

      logger.info('ELEVATED Memory Pressure detected', {
        rssMb: telemetry.rssMb,
        elevatedLimitMb: Math.round(elevatedLimitMb),
        pressureRatio: `${(telemetry.pressureRatio * 100).toFixed(1)}%`
      });

      // Proactive GC to prevent reaching critical threshold
      this.triggerGarbageCollection('elevated_memory_pressure');
    } else {
      this._state = MemoryPressureState.NORMAL;
      this._consecutiveCriticalCount = 0;

      // Also clean up if heap fragmentation is abnormally high (> 50% unused heap space)
      if (telemetry.fragmentationRatio > 0.50 && telemetry.heapTotalMb > 64) {
        this.triggerGarbageCollection('high_fragmentation');
      }
    }

    if (this._eventLoopLagMs > 150) {
      logger.warn('Event loop lag elevated', { lagMs: this._eventLoopLagMs });
    }
  }

  /**
   * Executes all registered emergency eviction callbacks.
   */
  async triggerEmergencyPrune() {
    logger.warn(`Executing ${this._emergencyEvictionHooks.length} emergency eviction hook(s)`);
    for (const hook of this._emergencyEvictionHooks) {
      try {
        await Promise.resolve(hook());
      } catch (err) {
        logger.error('Error executing emergency eviction hook', err);
      }
    }
  }

  /**
   * Safely invoke global.gc() if exposed.
   * @param {string} reason
   * @returns {boolean} Whether GC was invoked
   */
  triggerGarbageCollection(reason = 'manual') {
    if (typeof global.gc === 'function') {
      try {
        const memBefore = process.memoryUsage().rss / (1024 * 1024);
        global.gc();
        const memAfter = process.memoryUsage().rss / (1024 * 1024);
        this._totalGcTriggered++;
        logger.info(`V8 Garbage Collection executed (reason: ${reason})`, {
          freedMb: Number((memBefore - memAfter).toFixed(2)),
          currentRssMb: Number(memAfter.toFixed(2)),
          totalGcCount: this._totalGcTriggered
        });
        return true;
      } catch (err) {
        logger.error('Failed to execute global.gc()', err);
      }
    }
    return false;
  }
}

/**
 * Singleton instance of TelemetryWatchdogDaemon.
 * @type {TelemetryWatchdogDaemon}
 */
export const telemetryWatchdog = new TelemetryWatchdogDaemon();
