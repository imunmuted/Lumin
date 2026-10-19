/**
 * @fileoverview Unit tests for Count-Min Sketch and Fast In-Memory Cache (W-TinyLFU).
 * Verifies frequency tracking, admission policies, strict 25MB heap ceiling,
 * and emergency cold-entry pruning.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { memoryCache } from '../memory/MemoryCache.js';

describe('FastMemoryCache and CountMinSketch Subsystem', () => {
  beforeEach(() => {
    memoryCache.clearCache();
  });

  describe('CountMinSketch Frequency Tracking', () => {
    it('should accurately count frequencies for repeated queries', () => {
      const sketch = memoryCache.sketch;
      const key = 'test_cognitive_query_alpha';

      expect(sketch.estimate(key)).toBe(0);

      for (let i = 0; i < 5; i++) {
        sketch.add(key);
      }

      expect(sketch.estimate(key)).toBe(5);
    });

    it('should saturate 4-bit counters at 15 without overflow', () => {
      const sketch = memoryCache.sketch;
      const key = 'high_frequency_query';

      for (let i = 0; i < 30; i++) {
        sketch.add(key);
      }

      expect(sketch.estimate(key)).toBe(15);
    });

    it('should decay frequencies when halving is triggered', () => {
      const sketch = memoryCache.sketch;
      const key = 'decay_test_key';

      for (let i = 0; i < 8; i++) {
        sketch.add(key);
      }

      expect(sketch.estimate(key)).toBe(8);
      sketch.decay();
      expect(sketch.estimate(key)).toBe(4);
    });
  });

  describe('MemoryCache Storage and Eviction', () => {
    it('should cache and retrieve query results', () => {
      const query = 'what is helium?';
      const historyId = 'user_channel_123';
      const results = [{ text: 'Helium is element 2', similarity: 0.95 }];

      memoryCache.setQueryResult(query, historyId, results);
      const cached = memoryCache.getQueryResult(query, historyId);

      expect(cached).not.toBeNull();
      expect(cached).toEqual(results);
    });

    it('should invalidate cache when historyId is cleared', () => {
      const query = 'recall past conversation';
      const historyId = 'hist_999';

      memoryCache.setQueryResult(query, historyId, [{ text: 'data' }]);
      expect(memoryCache.getQueryResult(query, historyId)).not.toBeNull();

      memoryCache.invalidateQueryCache(historyId);
      expect(memoryCache.getQueryResult(query, historyId)).toBeNull();
    });

    it('should prune cold entries during emergency memory reduction', () => {
      const historyId = 'hist_prune';

      for (let i = 0; i < 10; i++) {
        const query = `query_sample_test_${i}`;
        memoryCache.setQueryResult(query, historyId, [{ id: i }]);
      }

      // Add high frequency to the second half
      for (let i = 5; i < 10; i++) {
        const query = `query_sample_test_${i}`;
        const hash = memoryCache.generateQueryHash(historyId, query, null, null);
        for (let f = 0; f < 5; f++) {
          memoryCache.sketch.add(hash);
        }
      }

      const statsBefore = memoryCache.getStats();
      expect(statsBefore.entries).toBe(10);

      memoryCache.pruneColdEntries();

      const statsAfter = memoryCache.getStats();
      expect(statsAfter.entries).toBe(5);
    });

    it('should track approximate byte sizes strictly below the 25MB ceiling', () => {
      const stats = memoryCache.getStats();
      expect(stats.maxBytesAllowed).toBe(25 * 1024 * 1024);
      expect(stats.approximateBytes).toBeLessThanOrEqual(stats.maxBytesAllowed);
    });
  });
});
