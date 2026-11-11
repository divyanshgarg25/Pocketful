import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ApiError } from '../src/lib/api';

// WCAG relative luminance calculator
function getRelativeLuminance(hex: string): number {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getRelativeLuminance(hex1);
  const l2 = getRelativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('Phase 10: Frontend A11y, Contrast, and Dialog Verification (F1-F4)', () => {
  it('verifies core Pocketful tokens meet WCAG AA contrast (>= 4.5:1)', () => {
    const linen = '#F3EBDD';
    const parchment = '#FAF6EE';
    const ink = '#2A1A17';
    const burgundy = '#6D1A2C';
    const crispWhite = '#FFFFFF';
    const charcoal = '#2C302E';

    // 1. Ink text on Linen background
    const inkLinenRatio = getContrastRatio(ink, linen);
    expect(inkLinenRatio).toBeGreaterThanOrEqual(4.5);

    // 2. Ink text on Parchment background
    const inkParchmentRatio = getContrastRatio(ink, parchment);
    expect(inkParchmentRatio).toBeGreaterThanOrEqual(4.5);

    // 3. Charcoal text on Crisp White cards
    const charcoalWhiteRatio = getContrastRatio(charcoal, crispWhite);
    expect(charcoalWhiteRatio).toBeGreaterThanOrEqual(4.5);

    // 4. Parchment text on Burgundy wax seal/button
    const parchmentBurgundyRatio = getContrastRatio(parchment, burgundy);
    expect(parchmentBurgundyRatio).toBeGreaterThanOrEqual(4.5);

    // 5. Darkened Taupe text on Linen background (WCAG AA >= 4.5:1)
    const taupe = '#6B5B4A';
    const taupeLinenRatio = getContrastRatio(taupe, linen);
    expect(taupeLinenRatio).toBeGreaterThanOrEqual(4.5);

    // 6. Darkened Ochre text on Linen background (WCAG AA >= 4.5:1)
    const ochre = '#855305';
    const ochreLinenRatio = getContrastRatio(ochre, linen);
    expect(ochreLinenRatio).toBeGreaterThanOrEqual(4.5);
  });

  it('ApiError encapsulates typed code, status, and requestId', () => {
    const error = new ApiError('Request timed out', 408, 'REQUEST_TIMEOUT', undefined, 'req_123');
    expect(error.name).toBe('ApiError');
    expect(error.message).toBe('Request timed out');
    expect(error.status).toBe(408);
    expect(error.code).toBe('REQUEST_TIMEOUT');
    expect(error.requestId).toBe('req_123');
  });

  it('verifies all modals implement standard role="dialog" and aria-modal="true"', () => {
    const componentsDir = path.resolve(__dirname, '../src/components');
    const modalFiles = [
      'SundayVaultModal.tsx',
      'WeekendReceiptModal.tsx',
      'ActionLogModal.tsx',
      'PipDrawer.tsx'
    ];

    for (const file of modalFiles) {
      const content = fs.readFileSync(path.join(componentsDir, file), 'utf-8');
      expect(content).toContain('role="dialog"');
      expect(content).toContain('aria-modal="true"');
      expect(content).toContain('useModalA11y');
    }
  });

  it('verifies ApprovalSeal has aria-live region and accessible non-hold approval alternative', () => {
    const sealPath = path.resolve(__dirname, '../src/components/ApprovalSeal.tsx');
    const content = fs.readFileSync(sealPath, 'utf-8');

    expect(content).toContain('aria-live="polite"');
    expect(content).toContain('prefersReducedMotion');
    expect(content).toContain('formatCountdown');
    expect(content).toContain('Approve');
    expect(content).toContain('I have reviewed this');
  });

  it('confirms zero unhandled browser alert() calls in src directory', () => {
    const srcDir = path.resolve(__dirname, '../src');

    function scanDir(dir: string): string[] {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...scanDir(fullPath));
        } else if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts')) {
          const code = fs.readFileSync(fullPath, 'utf-8');
          // Match alert(...) but ignore alerts in comments or string literals
          const lines = code.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.includes('alert(') && !line.trim().startsWith('//') && !line.includes('role="alert"')) {
              results.push(`${fullPath}:${i + 1}: ${line.trim()}`);
            }
          }
        }
      }
      return results;
    }

    const alertOccurrences = scanDir(srcDir);
    expect(alertOccurrences).toEqual([]);
  });
});
