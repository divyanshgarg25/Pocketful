import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '../../..');

describe('M4: no AI-prompt / handoff files, and internal docs stay out of repository tracking', () => {
  const rootFiles = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

  it('CLAUDE_AUDIT_PROMPT.md and HANDOFF_PROMPT.md are gone from the root', () => {
    expect(rootFiles).not.toContain('CLAUDE_AUDIT_PROMPT.md');
    expect(rootFiles).not.toContain('HANDOFF_PROMPT.md');
  });

  it('no file at the root looks like a prompt/handoff artefact', () => {
    const bad = rootFiles.filter((f) => /(^|[_\-. ])(prompt|handoff|hand-off)([_\-. ]|$)/i.test(f) || /^(CLAUDE|AGENTS|GEMINI|CURSOR)[_\-.].*PROMPT/i.test(f));
    expect(bad).toEqual([]);
  });

  it('no prompt or handoff files exist across the workspace', () => {
    function findBadFiles(dir: string): string[] {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const bad: string[] = [];
      for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'coverage') continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          bad.push(...findBadFiles(fullPath));
        } else if (entry.isFile()) {
          if (/(^|[_\-. ])(prompt|handoff|hand-off)([_\-. ]|$)/i.test(entry.name) || /^(CLAUDE|AGENTS|GEMINI|CURSOR)[_\-.].*PROMPT/i.test(entry.name)) {
            if (entry.name !== 'StepUpPromptHost.tsx' && entry.name !== 'repo-hygiene-prompts.test.ts') {
              bad.push(path.relative(root, fullPath));
            }
          }
        }
      }
      return bad;
    }
    expect(findBadFiles(root)).toEqual([]);
  });

  it('.gitignore properly ignores internal specification documents', () => {
    const gitignorePath = path.join(root, '.gitignore');
    expect(fs.existsSync(gitignorePath)).toBe(true);
    const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
    const requiredIgnored = [
      'Pocketful App Flow and UI UX Design Document.md',
      'Pocketful Backend and Database Schema Document.md',
      'Pocketful Product Requirements Document.md',
      'Pocketful Technical Requirements Document.md',
      'CLAUDE_AUDIT_PROMPT.md',
      'HANDOFF_PROMPT.md'
    ];
    for (const doc of requiredIgnored) {
      expect(gitignoreContent).toContain(doc);
    }
  });
});
