/**
 * @fileoverview Mathematical and Cognitive Model Verification Tests for Project Helium.
 * Validates the Ebbinghaus forgetting curve, spaced retrieval potentiation,
 * composite cognitive ranking, and privacy admissibility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateEbbinghausRetention,
  potentiateMemoryStability,
  calculateCompositeRank,
  isFactAdmissible,
} from '../memory/MemorySystem.js';

describe('Cognitive Brain Memory Mathematics', () => {
  describe('Ebbinghaus Forgetting Curve: R(Δt) = exp(-Δt / (S * I))', () => {
    it('should return exactly 1.0 when elapsed time Δt is 0', () => {
      const now = Date.now();
      const retention = calculateEbbinghausRetention(now, 1.0, 1.0);
      expect(retention).toBeCloseTo(1.0, 5);
    });

    it('should monotonically decrease over time', () => {
      const now = Date.now();
      const oneHourAgo = now - 3600 * 1000;
      const oneDayAgo = now - 86400 * 1000;
      const oneWeekAgo = now - 7 * 86400 * 1000;

      const rHour = calculateEbbinghausRetention(oneHourAgo);
      const rDay = calculateEbbinghausRetention(oneDayAgo);
      const rWeek = calculateEbbinghausRetention(oneWeekAgo);

      expect(rHour).toBeLessThanOrEqual(1.0);
      expect(rHour).toBeGreaterThan(rDay);
      expect(rDay).toBeGreaterThan(rWeek);
      expect(rWeek).toBeGreaterThan(0.0);
    });

    it('should retain higher stability for high-importance facts', () => {
      const now = Date.now();
      const threeDaysAgo = now - 3 * 86400 * 1000;

      const lowImportance = calculateEbbinghausRetention(threeDaysAgo, 1.0, 1.0);
      const highImportance = calculateEbbinghausRetention(threeDaysAgo, 1.0, 3.0); // 3x importance

      expect(highImportance).toBeGreaterThan(lowImportance);
    });

    it('should handle undefined, future, or invalid timestamps safely without NaN', () => {
      expect(calculateEbbinghausRetention(null)).toBeGreaterThan(0);
      expect(calculateEbbinghausRetention(undefined)).toBeGreaterThan(0);
      expect(calculateEbbinghausRetention(Date.now() + 100000)).toBeCloseTo(1.0, 3);
      expect(Number.isNaN(calculateEbbinghausRetention('invalid'))).toBe(false);
    });
  });

  describe('Spaced Retrieval Potentiation: S_{n+1} = S_n(1 + α * P * exp(-β * R))', () => {
    it('should increase memory stability after successful recall', () => {
      const initialStability = 1.0;
      const retentionAtRecall = 0.5; // recalled when half-forgotten
      const potentiationFactor = 1.2;

      const newStability = potentiateMemoryStability(
        initialStability,
        retentionAtRecall,
        potentiationFactor
      );

      expect(newStability).toBeGreaterThan(initialStability);
    });

    it('should produce greater potentiation when recalled at lower retention (desirable difficulty)', () => {
      const initialStability = 1.0;
      
      // Difficult recall (low retention) vs easy immediate recall (high retention)
      const difficultRecall = potentiateMemoryStability(initialStability, 0.2, 1.0);
      const easyRecall = potentiateMemoryStability(initialStability, 0.9, 1.0);

      expect(difficultRecall).toBeGreaterThan(easyRecall);
    });
  });

  describe('Composite Cognitive Ranking Formula', () => {
    it('should balance similarity, retention, and importance weights', () => {
      const rank = calculateCompositeRank(0.85, 0.90, 2.0); // sim=0.85, rec=0.90, imp=2.0 (out of 3)
      expect(rank).toBeGreaterThan(0);
      expect(rank).toBeLessThanOrEqual(1.0);
    });

    it('should rank high-similarity fresh memories above low-similarity stale memories', () => {
      const highRank = calculateCompositeRank(0.95, 0.95, 1.0);
      const lowRank = calculateCompositeRank(0.40, 0.30, 1.0);
      expect(highRank).toBeGreaterThan(lowRank);
    });
  });

  describe('Privacy Admissibility Filtering', () => {
    it('should admit personal facts when personalization toggle is enabled', () => {
      const isPersonal = true;
      const personalization = true;
      const isDm = false;

      expect(isFactAdmissible('User likes jazz', personalization, isDm, isPersonal)).toBe(true);
    });

    it('should reject personal facts in public server when personalization is disabled', () => {
      const isPersonal = true;
      const personalization = false;
      const isDm = false;

      expect(isFactAdmissible('User likes jazz', personalization, isDm, isPersonal)).toBe(false);
    });

    it('should always admit personal facts inside private DMs regardless of server toggle', () => {
      const isPersonal = true;
      const personalization = false;
      const isDm = true;

      expect(isFactAdmissible('User likes jazz', personalization, isDm, isPersonal)).toBe(true);
    });

    it('should always admit non-personal server facts in public channels', () => {
      const isPersonal = false;
      const personalization = false;
      const isDm = false;

      expect(isFactAdmissible('Server rules: no spam', personalization, isDm, isPersonal)).toBe(true);
    });
  });
});
