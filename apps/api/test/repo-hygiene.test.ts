import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const root = path.resolve(__dirname, '../../..');
const isGitRepo = fs.existsSync(path.join(root, '.git'));
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf-8').replace(/\r\n/g, '\n');

describe('E6: repo and supply-chain hygiene', () => {
  const ci = read('.github/workflows/ci.yml');

  it('CI audits dependencies, lints, typechecks, tests, builds and scans for secrets', () => {
    expect(ci).toMatch(/npm audit --audit-level=high/);
    expect(ci).toMatch(/npm run lint/);
    expect(ci).toMatch(/npm run typecheck/);
    expect(ci).toMatch(/npm test/);
    expect(ci).toMatch(/npm run build/);
    expect(ci).toMatch(/test:coverage/);
    expect(ci).toMatch(/gitleaks detect[^\n]*--config \.gitleaks\.toml/);
    expect(ci).toMatch(/fetch-depth: 0/); // the secret scan needs full history
  });

  it('CI pins the tools it downloads to exact versions', () => {
    expect(ci).toMatch(/gitleaks\/releases\/download\/v\d+\.\d+\.\d+\//);
    expect(ci).toMatch(/postgrest\/releases\/download\/v\d+\.\d+\.\d+\//);
    expect(ci).not.toMatch(/releases\/latest/);
  });

  it('the coverage gate holds the money-critical modules to 95%', () => {
    const cfg = read('apps/api/vitest.config.ts');
    for (const f of ['agents/guardian.ts', 'agents/splitter.ts', 'services/money.ts', 'services/stepup.ts']) {
      expect(cfg, f).toMatch(new RegExp(`'src/${f.replace('.', '\\.')}': \\{ lines: 9[5-9]`));
    }
  });

  it('a gitleaks config exists and allowlists exact fixture values, never whole directories', () => {
    const cfg = read('.gitleaks.toml');
    expect(cfg).toMatch(/useDefault = true/);
    expect(cfg).not.toMatch(/^\s*paths\s*=/m);
  });

  it('Dependabot and a security-focused PR template exist', () => {
    expect(read('.github/dependabot.yml')).toMatch(/package-ecosystem: npm/);
    expect(read('.github/dependabot.yml')).toMatch(/package-ecosystem: github-actions/);
    expect(read('.github/pull_request_template.md')).toMatch(/Security checklist/);
  });

  it('lint is real ESLint (not a second typecheck) and forbids console in production code', () => {
    for (const p of ['package.json', 'apps/api/package.json', 'apps/web/package.json']) {
      const lint = JSON.parse(read(p)).scripts?.lint as string;
      expect(lint, p).toBeTruthy();
      expect(lint, p).not.toMatch(/tsc/);
    }
    expect(read('eslint.config.mjs')).toMatch(/'no-console': 'error'/);
  });

  it.skipIf(!isGitRepo)('no .env file is tracked by git (only .env.example)', () => {
    const tracked = execSync('git ls-files', { cwd: root }).toString().split('\n').filter(Boolean);
    expect(tracked.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example'))).toEqual([]);
  });

  it('.gitignore keeps real env files out and .env.example in', () => {
    expect(read('.gitignore')).toMatch(/^\.env$/m);
    expect(read('.gitignore')).toMatch(/!\.env\.example/);
  });

  it('dependencies the audit flagged as unused stay removed', () => {
    const api = JSON.parse(read('apps/api/package.json'));
    const web = JSON.parse(read('apps/web/package.json'));
    const all = (j: { dependencies?: object; devDependencies?: object }) => Object.keys({ ...j.dependencies, ...j.devDependencies });
    expect(all(api)).not.toContain('ts-node');
    for (const d of ['@tanstack/react-query', 'framer-motion', 'leaflet', '@types/leaflet', 'lucide-react']) {
      expect(all(web), d).not.toContain(d);
    }
  });

  it('the minimatch advisory override is still in place until typescript-eslint ships a patched dependency', () => {
    expect(JSON.parse(read('package.json')).overrides?.minimatch).toMatch(/\^?11\.\d+\.\d+/);
  });

  it('every dependency in the API and web package.json is imported somewhere (no new dead weight)', () => {
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'coverage'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx|js|mjs|cjs|css|html)$/.test(e.name)) acc.push(p);
      }
      return acc;
    };
    // Packages that are used implicitly (config files, CLIs, type-only, or peer requirements).
    const implicit = new Set(['typescript', 'postcss', 'autoprefixer', 'tailwindcss', 'vite', 'vitest', 'tsx', '@vitejs/plugin-react', '@types/node', '@types/react', '@types/react-dom', '@types/express', '@types/cors', '@types/supertest', '@types/pg', 'eslint', 'typescript-eslint', '@vitest/coverage-v8']);
    for (const app of ['api', 'web']) {
      const pj = JSON.parse(read(`apps/${app}/package.json`));
      const src = walk(path.join(root, 'apps', app)).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');
      const deps = Object.keys({ ...pj.dependencies, ...pj.devDependencies });
      const unused = deps.filter((d) => !implicit.has(d) && !d.startsWith('@types/') && !src.includes(d));
      expect(unused, `${app} has declared-but-unused dependencies`).toEqual([]);
    }
  });
});
