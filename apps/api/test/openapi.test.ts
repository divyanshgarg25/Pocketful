import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import app from '../src/index.js';

describe('Phase 11: OpenAPI Specification Drift & Coverage Test (M-docs)', () => {
  const openapiPath = path.resolve(__dirname, '../../../openapi.yaml');

  it('openapi.yaml exists and is well-formed', () => {
    expect(fs.existsSync(openapiPath)).toBe(true);
    const content = fs.readFileSync(openapiPath, 'utf-8');
    expect(content).toContain('openapi: 3.1.0');
    expect(content).toContain('title: Pocketful Autonomous Lifestyle Financial Agent API');
  });

  it('documents 100% of registered Express routes without drift', () => {
    const content = fs.readFileSync(openapiPath, 'utf-8');

    // Extract all registered routes from Express app._router.stack
    const expressRoutes: Array<{ path: string; method: string }> = [];

    function extractRoutes(stack: any[], basePath = '') {
      for (const layer of stack) {
        if (layer.route) {
          const routePath = basePath + layer.route.path;
          for (const method of Object.keys(layer.route.methods)) {
            expressRoutes.push({
              path: routePath,
              method: method.toLowerCase()
            });
          }
        } else if (layer.name === 'router' && layer.handle?.stack) {
          // Sub-router mounted via app.use(router)
          extractRoutes(layer.handle.stack, basePath);
        }
      }
    }

    // @ts-expect-error accessing private router stack
    if (app._router && app._router.stack) {
      // @ts-expect-error accessing private router stack
      extractRoutes(app._router.stack);
    }

    expect(expressRoutes.length).toBeGreaterThan(0);

    // Convert Express path parameter syntax (:id) to OpenAPI ({id})
    const toOpenApiPath = (p: string) => p.replace(/:([a-zA-Z0-9_]+)/g, '{$1}');

    const missingRoutes: string[] = [];

    // Slice the spec into { path -> Set<method> } so a documented path with the wrong/missing method is drift too.
    const specMethods = new Map<string, Set<string>>();
    let currentPath: string | null = null;
    let inPaths = false;
    for (const line of content.split(/\r?\n/)) {
      if (/^paths:\s*$/.test(line)) { inPaths = true; continue; }
      if (inPaths && /^[A-Za-z]/.test(line)) inPaths = false;
      if (!inPaths) continue;
      const pm = /^  (\/[^\s:]*):\s*$/.exec(line);
      if (pm) { currentPath = pm[1]!; specMethods.set(currentPath, new Set()); continue; }
      const mm = /^    (get|post|put|patch|delete):\s*$/.exec(line);
      if (mm && currentPath) specMethods.get(currentPath)!.add(mm[1]!);
    }

    for (const route of expressRoutes) {
      const openApiPath = toOpenApiPath(route.path);
      const methods = specMethods.get(openApiPath);
      if (!methods) {
        missingRoutes.push(`${route.method.toUpperCase()} ${openApiPath} (path not found in openapi.yaml)`);
      } else if (!methods.has(route.method)) {
        missingRoutes.push(`${route.method.toUpperCase()} ${openApiPath} (method not documented in openapi.yaml)`);
      }
    }

    expect(missingRoutes).toEqual([]);
  });

  it('documents critical Guardian security headers and error schemas', () => {
    const content = fs.readFileSync(openapiPath, 'utf-8');
    expect(content).toContain('BearerAuth:');
    expect(content).toContain('IdempotencyKey:');
    expect(content).toContain('VALIDATION_FAILED');
    expect(content).toContain('GUARDIAN_BLOCKED');
    expect(content).toContain('APPROVAL_EXPIRED');
    expect(content).toContain('IDEMPOTENT_REPLAY');
    expect(content).toContain('CONCURRENT_ACTION');
    expect(content).toContain('RATE_LIMITED');
  });

  it('documents every ErrorCode the API can return (enum parity)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/core/errors.ts'), 'utf-8');
    const block = src.slice(src.indexOf('export type ErrorCode ='), src.indexOf('export class AppError'));
    const inCode = [...block.matchAll(/\|\s*'([A-Z_]+)'/g)].map((m) => m[1]!).sort();
    const spec = fs.readFileSync(openapiPath, 'utf-8');
    const apiError = spec.slice(spec.indexOf('    ApiError:'));
    const enumBlock = apiError.slice(apiError.indexOf('enum:'), apiError.indexOf('example:'));
    const inSpec = [...enumBlock.matchAll(/-\s+([A-Z_]+)/g)].map((m) => m[1]!).sort();
    expect(inSpec).toEqual(inCode);
  });
});
