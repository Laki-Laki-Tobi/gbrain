import { describe, expect, test } from 'bun:test';
import { parseCallArguments, readStdinParams } from '../../src/commands/call.ts';

async function* stdin(...chunks: string[]): AsyncGenerator<string> {
  yield* chunks;
}

describe('gbrain call --stdin', () => {
  test('parses stdin form with --source while preserving the legacy form', () => {
    expect(parseCallArguments(['--source', 'default', '--stdin', 'remove_link']))
      .toEqual({ explicitSource: 'default', tool: 'remove_link', jsonStr: null, useStdin: true });
    expect(parseCallArguments(['restore_link_exact', '{"context":"legacy"}']))
      .toEqual({ explicitSource: null, tool: 'restore_link_exact', jsonStr: '{"context":"legacy"}', useStdin: false });
  });

  test('rejects ambiguous stdin and positional JSON forms', () => {
    expect(() => parseCallArguments(['--stdin', 'remove_link', '{"context":"secret"}']))
      .toThrow('--stdin does not accept positional JSON params');
  });

  test('reads JSON params from stdin without reflecting malformed input', async () => {
    await expect(readStdinParams(stdin('{"context":"secret-value"}')))
      .resolves.toEqual({ context: 'secret-value' });
    await expect(readStdinParams(stdin(''))).rejects.toThrow('stdin JSON params must not be empty');
    await expect(readStdinParams(stdin('{"context":"secret-value"')))
      .rejects.toThrow('stdin JSON params must be valid JSON');
  });

  test('enforces the stdin byte limit', async () => {
    await expect(readStdinParams(stdin(`{"context":"${'x'.repeat(1024 * 1024)}"}`)))
      .rejects.toThrow('stdin JSON params exceed 1048576 bytes');
  });
});
