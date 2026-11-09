import { describe, it, expect } from 'vitest';
import ts from 'typescript';
import path from 'node:path';
import { q } from './helpers.js';

/**
 * Static check: every supabaseClient.from('<table>') chain in src/{repos,jobs,routes,...}
 * may only name columns that exist in the migrated database. Uses the TypeScript type
 * checker so `.insert(typedVariable)` is checked by the variable's property names too.
 * Limitation (documented): values typed Record<string, unknown> expose no property names and are skipped.
 */
const API_ROOT = path.resolve(__dirname, '..');
const FILTER_METHODS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is', 'in', 'not', 'contains', 'containedBy', 'like', 'ilike', 'order', 'overlaps']);
const WRITE_METHODS = new Set(['insert', 'update', 'upsert']);

interface Ref { table: string; column: string; where: string }

function collect(): { refs: Ref[]; rpcs: Array<{ fn: string; where: string }>; tables: Set<string> } {
  const cfgPath = path.join(API_ROOT, 'tsconfig.json');
  const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, API_ROOT);
  const program = ts.createProgram(parsed.fileNames.filter((f) => f.includes(`${path.sep}src${path.sep}`)), parsed.options);
  const checker = program.getTypeChecker();
  const refs: Ref[] = [];
  const rpcs: Array<{ fn: string; where: string }> = [];
  const tables = new Set<string>();

  const str = (n: ts.Node | undefined): string | null => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);

  const selectCols = (s: string) =>
    s.split(',').map((x) => x.trim()).filter((x) => x && x !== '*' && !x.includes('(') && !x.includes(')') && !x.includes('!')).map((x) => x.split(':').pop()!.trim().split('::')[0]!.trim());

  const propsOf = (e: ts.Expression): string[] => {
    const t = checker.getTypeAtLocation(e);
    const target = t.isUnion() ? t.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined) && !(x.flags & ts.TypeFlags.Null)) : [t];
    const out = new Set<string>();
    for (const tt of target) {
      const elem = checker.isArrayType(tt) ? (checker.getTypeArguments(tt as ts.TypeReference)[0] as ts.Type) : tt;
      for (const p of elem.getProperties()) out.add(p.getName());
    }
    return [...out];
  };

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !sf.fileName.includes(`${path.sep}src${path.sep}`)) continue;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (method === 'rpc' && /supabaseClient|sb\b|supabase/i.test(node.expression.expression.getText())) {
          const fn = str(node.arguments[0]);
          if (fn) rpcs.push({ fn, where: `${path.relative(API_ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}` });
        }
        if (method === 'from' && /supabaseClient|supabase/i.test(node.expression.expression.getText())) {
          const table = str(node.arguments[0]);
          if (table) {
            tables.add(table);
            // Walk up the fluent chain.
            let cur: ts.Node = node;
            while (cur.parent && ts.isPropertyAccessExpression(cur.parent) && cur.parent.parent && ts.isCallExpression(cur.parent.parent)) {
              const call: ts.CallExpression = cur.parent.parent;
              const m = cur.parent.name.text;
              const where = `${path.relative(API_ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(call.getStart()).line + 1} .${m}()`;
              const a0 = call.arguments[0];
              if (FILTER_METHODS.has(m)) { const c = str(a0); if (c) refs.push({ table, column: c, where }); }
              else if (m === 'select') { const s = str(a0); if (s) selectCols(s).forEach((c) => refs.push({ table, column: c, where })); }
              else if (WRITE_METHODS.has(m) && a0) {
                propsOf(a0 as ts.Expression).forEach((c) => refs.push({ table, column: c, where }));
                const opts = call.arguments[1];
                if (opts && ts.isObjectLiteralExpression(opts)) {
                  for (const p of opts.properties) if (ts.isPropertyAssignment(p) && p.name.getText() === 'onConflict') {
                    const s = str(p.initializer); if (s) s.split(',').forEach((c) => refs.push({ table, column: c.trim(), where }));
                  }
                }
              }
              cur = call;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { refs, rpcs, tables };
}

describe('schema drift (A4)', () => {
  const found = collect();

  it('scanner actually found the repo calls (guards against a silently-empty check)', () => {
    expect(found.tables.size).toBeGreaterThan(15);
    expect(found.refs.length).toBeGreaterThan(80);
  });

  it('every table, column and rpc referenced via supabaseClient exists in the migrated database', async () => {
    const cols = (await q(`select table_name, column_name from information_schema.columns where table_schema='public'`)).rows;
    const have = new Map<string, Set<string>>();
    for (const r of cols) { if (!have.has(r.table_name)) have.set(r.table_name, new Set()); have.get(r.table_name)!.add(r.column_name); }
    const fns = new Set((await q(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)).rows.map((r) => r.proname));

    const problems: string[] = [];
    for (const t of found.tables) if (!have.has(t)) problems.push(`missing table: ${t}`);
    for (const r of found.refs) if (have.has(r.table) && !have.get(r.table)!.has(r.column)) problems.push(`${r.table}.${r.column} does not exist (${r.where})`);
    for (const r of found.rpcs) if (!fns.has(r.fn)) problems.push(`missing function ${r.fn} (${r.where})`);
    expect([...new Set(problems)], 'schema drift').toEqual([]);
  });
});
