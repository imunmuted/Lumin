/**
 * @fileoverview Unit tests for TelemetryWatchdogDaemon.
 * Verifies memory pressure detection, heap fragmentation calculations,
 * event loop lag measurement, and emergency eviction hooks.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  TelemetryWatchdogDaemon,
  MemoryPressureState
} from '../core/TelemetryWatchdogDaemon.js';

describe('TelemetryWatchdogDaemon', () => {
  it('should calculate telemetry statistics correctly', () => {
    const watchdog = new TelemetryWatchdogDaemon({
      renderRamLimitMb: 512,
      elevatedThresholdRatio: 0.70,
      criticalThresholdRatio: 0.85
    });

    const telemetry = watchdog.getTelemetry();

    expect(telemetry).toHaveProperty('rssMb');
    expect(telemetry).toHaveProperty('heapTotalMb');
    expect(telemetry).toHaveProperty('heapUsedMb');
    expect(telemetry).toHaveProperty('pressureRatio');
    expect(telemetry).toHaveProperty('fragmentationRatio');
    expect(telemetry).toHaveProperty('eventLoopLagMs');

    expect(telemetry.rssMb).toBeGreaterThan(0);
    expect(telemetry.fragmentationRatio).toBeGreaterThanOrEqual(0);
    expect(telemetry.fragmentationRatio).toBeLessThanOrEqual(1);
  });

  it('should measure event loop lag via performance timer', async () => {
    const watchdog = new TelemetryWatchdogDaemon();
    const lag = await watchdog.measureEventLoopLag();
    expect(typeof lag).toBe('number');
    expect(lag).toBeGreaterThanOrEqual(0);
  });

  it('should register and execute emergency eviction hooks on critical pressure', async () => {
    const watchdog = new TelemetryWatchdogDaemon({
      renderRamLimitMb: 1, // artificially low to trigger critical state
      criticalThresholdRatio: 0.5
    });

    const mockEvictionHook = vi.fn();
    watchdog.registerEmergencyEvictionHook(mockEvictionHook);

    await watchdog.triggerEmergencyPrune();

    expect(mockEvictionHook).toHaveBeenCalledTimes(1);

    watchdog.unregisterEmergencyEvictionHook(mockEvictionHook);
    await watchdog.triggerEmergencyPrune();
    expect(mockEvictionHook).toHaveBeenCalledTimes(1); // not called again
  });

  it('should safely no-op when global.gc is not available', () => {
    const watchdog = new TelemetryWatchdogDaemon();
    const result = watchdog.triggerGarbageCollection('test');
    expect(typeof result).toBe('boolean');
  });
});
