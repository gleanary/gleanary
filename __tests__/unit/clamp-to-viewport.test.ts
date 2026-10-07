import { describe, it, expect } from 'vitest';
import { clampToViewport } from '@/lib/clamp-to-viewport';

describe('clampToViewport', () => {
  describe('vertical clamping', () => {
    const viewportHeight = 800;

    it('returns original position when element fits within viewport', () => {
      const result = clampToViewport(200, 40, viewportHeight);
      expect(result).toBe(200);
    });

    it('clamps to minimum margin when element would be above viewport', () => {
      const result = clampToViewport(-10, 40, viewportHeight);
      expect(result).toBe(8);
    });

    it('clamps when element would extend below viewport', () => {
      const result = clampToViewport(780, 40, viewportHeight);
      // viewportHeight - elementHeight - margin = 800 - 40 - 8 = 752
      expect(result).toBe(752);
    });

    it('clamps to minimum when both edges are out of bounds', () => {
      // Element is taller than viewport: prefer showing top
      const result = clampToViewport(-50, 900, viewportHeight);
      expect(result).toBe(8);
    });

    it('handles zero position', () => {
      const result = clampToViewport(0, 40, viewportHeight);
      expect(result).toBe(8);
    });

    it('handles element exactly at bottom edge', () => {
      // position + elementSize = viewportSize exactly → should clamp to leave margin
      const result = clampToViewport(760, 40, viewportHeight);
      expect(result).toBe(752);
    });
  });

  describe('horizontal clamping', () => {
    const viewportWidth = 400;

    it('returns original position when element fits within viewport', () => {
      const result = clampToViewport(100, 200, viewportWidth);
      expect(result).toBe(100);
    });

    it('clamps to minimum margin when element would be off-screen left', () => {
      const result = clampToViewport(-20, 200, viewportWidth);
      expect(result).toBe(8);
    });

    it('clamps when element would extend beyond right edge', () => {
      const result = clampToViewport(300, 200, viewportWidth);
      // viewportWidth - elementWidth - margin = 400 - 200 - 8 = 192
      expect(result).toBe(192);
    });

    it('clamps to minimum when element is wider than viewport', () => {
      const result = clampToViewport(50, 500, viewportWidth);
      expect(result).toBe(8);
    });

    it('handles element exactly at right edge', () => {
      // position + elementSize = viewportSize → should clamp to leave margin
      const result = clampToViewport(200, 200, viewportWidth);
      expect(result).toBe(192);
    });
  });
});
