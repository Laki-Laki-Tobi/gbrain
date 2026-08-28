import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

const MAX_STDIN_PARAMS_BYTES = 1024 * 1024;

export type CallArguments = {
  explicitSource: string | null;
  tool: string;
  jsonStr: string | null;
  useStdin: boolean;
};

export function parseCallArguments(args: string[]): CallArguments {
  let explicitSource: string | null = null;
  let stdinTool: string | null = null;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--source') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--source requires an id');
      explicitSource = next;
      i++;
      continue;
    }
    if (arg.startsWith('--source=')) {
      const source = arg.slice('--source='.length);
      if (!source) throw new Error('--source requires an id');
      explicitSource = source;
      continue;
    }
    if (arg === '--stdin') {
      if (stdinTool !== null) throw new Error('--stdin may only be specified once');
      const next = args[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--stdin requires a tool name');
      stdinTool = next;
      i++;
      continue;
    }
    rest.push(arg);
  }

  if (stdinTool !== null) {
    if (rest.length) throw new Error('--stdin does not accept positional JSON params');
    return { explicitSource, tool: stdinTool, jsonStr: null, useStdin: true };
  }

  if (!rest[0]) throw new Error('a tool name is required');
  return { explicitSource, tool: rest[0], jsonStr: rest[1] ?? null, useStdin: false };
}

export async function readStdinParams(stdin: AsyncIterable<string | Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    size += bytes.length;
    if (size > MAX_STDIN_PARAMS_BYTES) throw new Error(`stdin JSON params exceed ${MAX_STDIN_PARAMS_BYTES} bytes`);
    chunks.push(bytes);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) throw new Error('stdin JSON params must not be empty');
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('stdin JSON params must be valid JSON');
  }
}

/**
 * `gbrain call <tool> <json>` or `gbrain call --stdin <tool>` — trusted local op-dispatch surface.
 *
 * v0.31.8 (D22): grammar accepts an optional `--source <id>` flag before the
 * tool name. The flag is the highest-priority tier in resolveSourceId()'s
 * 6-tier chain (--source > GBRAIN_SOURCE > .gbrain-source dotfile > path-match
 * > brain default > 'default'). Without --source, the chain still resolves —
 * env / dotfile / path-match all work.
 */
export async function runCall(engine: BrainEngine, args: string[]) {
  let call: CallArguments;
  try {
    call = parseCallArguments(args);
  } catch (error) {
    console.error(`gbrain call: ${error instanceof Error ? error.message : 'invalid arguments'}`);
    console.error("Usage: gbrain call [--source <id>] <tool> '<json>' | gbrain call [--source <id>] --stdin <tool>");
    process.exit(1);
  }

  let params: Record<string, unknown>;
  try {
    params = (call.useStdin ? await readStdinParams(process.stdin) : call.jsonStr ? JSON.parse(call.jsonStr) : {}) as Record<string, unknown>;
  } catch (error) {
    console.error(`gbrain call: ${error instanceof Error ? error.message : 'invalid JSON params'}`);
    process.exit(1);
  }
  // Resolve through the canonical 6-tier chain. resolveSourceId() throws if
  // an explicit/env/dotfile id refers to a non-registered source.
  const sourceId = await resolveSourceId(engine, call.explicitSource);
  const result = await handleToolCall(engine, call.tool, params, { sourceId });
  console.log(JSON.stringify(result, null, 2));
}
