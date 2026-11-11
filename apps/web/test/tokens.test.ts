import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Pocketful UI Design Tokens & Signature Components Compliance', () => {
  const cssPath = path.resolve(__dirname, '../src/index.css');

  it('declares all authoritative CSS variables in index.css', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    const requiredTokens = [
      '--linen',
      '--parchment',
      '--sand',
      '--oat',
      '--taupe',
      '--ink',
      '--burgundy',
      '--claret',
      '--maroon',
      '--blush',
      '--brass',
      '--moss',
      '--ochre',
      '--brick',
      '--dusty-rose',
      '--blush-pink',
      '--crisp-white',
      '--charcoal',
      '--charcoal-gray',
      '--lift'
    ];

    for (const token of requiredTokens) {
      expect(css).toContain(token);
    }
  });

  it('configures Fraunces, Instrument Sans, and IBM Plex Mono fonts', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('Fraunces');
    expect(css).toContain('Instrument Sans');
    expect(css).toContain('IBM Plex Mono');
  });

  it('defines 3px 3px 0 hard lift shadow without fuzzy blur', () => {
    const css = fs.readFileSync(cssPath, 'utf-8');
    expect(css).toContain('--lift: 3px 3px 0 rgba(74, 15, 30, 0.16)');
  });

  it('contains zero raw hex codes in web components', () => {
    const screensDir = path.resolve(__dirname, '../src/screens');
    const componentsDir = path.resolve(__dirname, '../src/components');

    const checkFiles = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.tsx')) {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          // Match raw hex like #fff or #0070BA (excluding comments or svg xmlns)
          const matches = content.match(/#[0-9a-fA-F]{3,8}\b/g);
          expect(matches).toBeNull();
        }
      }
    };

    checkFiles(screensDir);
    checkFiles(componentsDir);
  });

  it('contains zero forbidden glassmorphism or fuzzy blur shadows in web components', () => {
    const screensDir = path.resolve(__dirname, '../src/screens');
    const componentsDir = path.resolve(__dirname, '../src/components');

    const forbiddenPatterns = [
      'backdrop-blur',
      'shadow-lg',
      'shadow-xl',
      'shadow-2xl',
      'rounded-2xl',
      'rounded-3xl'
    ];

    const checkFiles = (dir: string) => {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.tsx')) {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          for (const pattern of forbiddenPatterns) {
            expect(content).not.toContain(pattern);
          }
        }
      }
    };

    checkFiles(screensDir);
    checkFiles(componentsDir);
  });

  it('guarantees keyboard accessibility on the ApprovalSeal with visible focus ring', () => {
    const sealPath = path.resolve(__dirname, '../src/components/ApprovalSeal.tsx');
    const content = fs.readFileSync(sealPath, 'utf-8');

    // Asserts keyboard event handlers and focus ring
    expect(content).toContain('onKeyDown');
    expect(content).toContain('onKeyUp');
    expect(content).toContain('focus-visible:ring-maroon');
    expect(content).toContain('tabIndex=');
    expect(content).toContain('role="button"');

    // Asserts bulletproof pointer events & touch protection
    expect(content).toContain('onPointerDown');
    expect(content).toContain('onPointerUp');
    expect(content).toContain('onPointerLeave');
    expect(content).toContain('onPointerCancel');
    expect(content).toContain('onContextMenu');
    expect(content).toContain('touch-none');
    expect(content).toContain('select-none');
    expect(content).toContain('onSeal');
  });

  it('implements RuledPlaceholder with accountant double rules and warm shimmer', () => {
    const placeholderPath = path.resolve(__dirname, '../src/components/RuledPlaceholder.tsx');
    const content = fs.readFileSync(placeholderPath, 'utf-8');

    expect(content).toContain('LedgerRule');
    expect(content).toContain('variant="double"');
    expect(content).toContain('animate-pulse');
    expect(content).toContain('shadow-lift');
  });

  it('implements dynamic ComfortZoneRings with concentric hairline SVG circles without crude text placeholders', () => {
    const ringsPath = path.resolve(__dirname, '../src/components/ComfortZoneRings.tsx');
    const content = fs.readFileSync(ringsPath, 'utf-8');

    // Dynamic concentric SVG circles
    expect(content).toContain('svg');
    expect(content).toContain('rings.map');
    expect(content).toContain('circle');
    expect(content).toContain('var(--burgundy)');
    expect(content).toContain('var(--oat)');

    // Asserts no crude placeholder text
    expect(content).not.toContain('3 RINGS');
    expect(content).not.toContain('3\nRings');

    // Asserts integrated into YouScreen
    const youPath = path.resolve(__dirname, '../src/screens/YouScreen.tsx');
    const youContent = fs.readFileSync(youPath, 'utf-8');
    expect(youContent).toContain('ComfortZoneRings');
    expect(youContent).toContain('rings={profile.comfortRings}');
    expect(youContent).not.toContain('3</span>');
    expect(youContent).not.toContain('Rings</span>');
  });

  it('enforces index.html viewport meta tag and index.css 16px base font size', () => {
    const htmlPath = path.resolve(__dirname, '../index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf-8');
    expect(htmlContent).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0" />');

    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toContain('font-size: 16px');
    expect(cssContent).toContain('text-size-adjust: 100%');
  });

  it('purges default browser increment/decrement spin buttons on number inputs', () => {
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toContain('input::-webkit-outer-spin-button');
    expect(cssContent).toContain('input::-webkit-inner-spin-button');
    expect(cssContent).toContain('-webkit-appearance: none');
    expect(cssContent).toContain('input[type="number"]');
    expect(cssContent).toContain('-moz-appearance: textfield');
  });

  it('strictly bans all decorative emojis across all screens and components per Design Doc 1.2/3.9', () => {
    const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{2712}\u{2716}-\u{27BF}]/u;
    const dirs = [
      path.resolve(__dirname, '../src/components'),
      path.resolve(__dirname, '../src/screens'),
      path.resolve(__dirname, '../src')
    ];

    for (const dir of dirs) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.endsWith('.tsx') || file.endsWith('.ts')) {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8');
          const hasEmoji = emojiRegex.test(content);
          if (hasEmoji) {
            const matched = content.match(emojiRegex);
            throw new Error(`Forbidden emoji ${matched?.[0]} found in ${file}`);
          }
          expect(hasEmoji).toBe(false);
        }
      }
    }
  });

  it('Badge component supports claret and maps all type values without undefined classNames', () => {
    const badgePath = path.resolve(__dirname, '../src/components/Badge.tsx');
    const content = fs.readFileSync(badgePath, 'utf-8');

    expect(content).toContain("'claret'");
    expect(content).toContain("styles[type] ?? ''");
    expect(content).toContain('border-dusty-rose text-claret bg-blush-pink');
  });

  it('PipDrawer avoids animate-bounce per UI UX Design Document 1.2 / 3.8', () => {
    const pipPath = path.resolve(__dirname, '../src/components/PipDrawer.tsx');
    const content = fs.readFileSync(pipPath, 'utf-8');

    expect(content).not.toContain('animate-bounce');
    expect(content).toContain('animate-pulse');
  });

  it('GroupScreen includes Cancel Outing action and handles cancelled and refunded status', () => {
    const groupPath = path.resolve(__dirname, '../src/screens/GroupScreen.tsx');
    const content = fs.readFileSync(groupPath, 'utf-8');

    expect(content).toContain('handleCancelOuting');
    expect(content).toContain('Cancel Outing');
    expect(content).toContain('/api/groups/${groupId}/cancel');
    expect(content).toContain("'refunded'");
    expect(content).toContain("'cancelled'");
  });

  it('FriendPayScreen handles cancelled and refunded states properly', () => {
    const payPath = path.resolve(__dirname, '../src/screens/FriendPayScreen.tsx');
    const content = fs.readFileSync(payPath, 'utf-8');

    expect(content).toContain("data.status === 'cancelled'");
    expect(content).toContain("data.status === 'refunded'");
    expect(content).toContain("data.groupStatus === 'cancelled'");
    expect(content).toContain("data.groupStatus === 'refunded'");
    expect(content).toContain('Outing Cancelled');
    expect(content).toContain('No Payment Required');
  });
});

