import { describe, expect, test } from 'bun:test';
import type postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

type Sql = ReturnType<typeof postgres>;

function queryText(strings: TemplateStringsArray): string {
  return strings.join('?').replace(/\s+/g, ' ').trim();
}

describe('PostgresEngine.setPageAliases transaction routing', () => {
  test('reuses an existing transaction instead of calling begin on its scoped sql object', async () => {
    const statements: string[] = [];
    let beginCount = 0;
    const tx = (async (strings: TemplateStringsArray) => {
      statements.push(queryText(strings));
      return [];
    }) as unknown as Sql;
    const pool = Object.assign(
      async () => [],
      {
        begin: async <T>(fn: (transaction: Sql) => Promise<T>): Promise<T> => {
          beginCount += 1;
          return fn(tx);
        },
      },
    ) as unknown as Sql;
    const engine = new PostgresEngine();
    Object.defineProperty(engine, 'sql', { get: () => pool });

    await engine.transaction(async scoped => {
      await scoped.setPageAliases('projects/example', 'default', ['alias one', 'alias one', 'alias two']);
    });

    expect(beginCount).toBe(1);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('DELETE FROM page_aliases');
    expect(statements[1]).toContain('INSERT INTO page_aliases');
  });

  test('opens one transaction when called from an unscoped engine', async () => {
    const statements: string[] = [];
    let beginCount = 0;
    const tx = (async (strings: TemplateStringsArray) => {
      statements.push(queryText(strings));
      return [];
    }) as unknown as Sql;
    const pool = Object.assign(
      async () => [],
      {
        begin: async <T>(fn: (transaction: Sql) => Promise<T>): Promise<T> => {
          beginCount += 1;
          return fn(tx);
        },
      },
    ) as unknown as Sql;
    const engine = new PostgresEngine();
    Object.defineProperty(engine, 'sql', { get: () => pool });

    await engine.setPageAliases('projects/example', 'default', []);

    expect(beginCount).toBe(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('DELETE FROM page_aliases');
  });
});
