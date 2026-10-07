/**
 * The published MCP tool reference, generated from the server's own registrations.
 *
 * `registerSuperpipelineTools` is run against a recording stand-in for the MCP server, with an
 * unscoped principal so every tool registers. What it records — each tool's name, description,
 * input schema and annotations — is exactly what `tools/list` serves an agent, so the page cannot
 * describe an argument the server does not take. That was not hypothetical: the hand-written table
 * in `build/mcp.md` listed `heartbeat` as `runId, leaseEpoch`, and the tool also requires `boardId`.
 *
 * Imported by path at run time, not statically: `apps/api` is typed against the Workers runtime,
 * which this package's `tsc` does not load.
 */
import { join } from 'node:path';
import { z } from 'zod';

export const MCP_PAGE = 'reference/mcp-tools.md';

export interface RecordedTool {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  scope: string | undefined;
}

export async function recordTools(repo: string): Promise<RecordedTool[]> {
  const mod = (await import(join(repo, 'apps/api/src/mcp/tools.ts'))) as {
    registerSuperpipelineTools: (server: unknown, deps: unknown) => void;
    TOOL_SCOPE: Record<string, string | undefined>;
  };
  const tools: RecordedTool[] = [];
  const server = {
    registerTool(name: string, config: Omit<RecordedTool, 'name' | 'scope'>) {
      tools.push({ name, ...config, scope: mod.TOOL_SCOPE[name] });
      return {};
    },
  };
  const unused = () => {
    throw new Error('the reference generator never calls a tool');
  };
  mod.registerSuperpipelineTools(server, {
    // `scopes: null` is the unscoped principal: every tool registers, which is the whole catalogue.
    auth: { tenantId: 'tnt_ref', agentId: 'agt_ref', capabilities: [], scopes: null },
    boardStub: unused,
    listBoards: unused,
  });
  return tools;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** Internal design-doc pointers (`(docs/08)`) mean nothing to a reader of the published site. */
const publicText = (s: string) => s.replace(/\s*\(docs\/[^)]*\)/g, '');

/** A JSON Schema fragment, as a short type a person reads. */
function typeOf(schema: Record<string, unknown>): string {
  if (Array.isArray(schema.enum)) return `one of ${(schema.enum as unknown[]).map((v) => `\`${String(v)}\``).join(', ')}`;
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as Record<string, unknown>[]).map(typeOf).join(' or ');
  const t = schema.type;
  const bounds: string[] = [];
  if (typeof schema.minimum === 'number') bounds.push(`≥ ${schema.minimum}`);
  if (typeof schema.exclusiveMinimum === 'number') bounds.push(`> ${schema.exclusiveMinimum}`);
  if (typeof schema.maximum === 'number' && schema.maximum < Number.MAX_SAFE_INTEGER) bounds.push(`≤ ${schema.maximum}`);
  if (typeof schema.minLength === 'number' && schema.minLength > 0) bounds.push('non-empty');
  if (typeof schema.minItems === 'number' && schema.minItems > 0) bounds.push(`at least ${schema.minItems}`);
  if (typeof schema.maxItems === 'number') bounds.push(`at most ${schema.maxItems}`);
  let base: string;
  if (t === 'array') base = `array of ${schema.items ? typeOf(schema.items as Record<string, unknown>) : 'any'}`;
  else if (t === 'object') {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
    base = props && Object.keys(props).length > 0 ? `object { ${Object.keys(props).join(', ')} }` : 'object';
  } else if (typeof t === 'string') base = t;
  else base = 'any JSON';
  return bounds.length > 0 ? `${base} (${bounds.join(', ')})` : base;
}

function hints(a: RecordedTool['annotations']): string {
  if (!a) return '—';
  const out: string[] = [a.readOnlyHint ? 'read-only' : 'writes'];
  if (a.destructiveHint) out.push('destructive');
  if (a.idempotentHint) out.push('idempotent');
  return out.join(', ');
}

export function renderMcpReference(tools: RecordedTool[]): string {
  const lines: string[] = [
    '---',
    'title: "MCP tool reference"',
    'description: "Every tool superpipeline\'s MCP server registers: arguments, types, scope and hints, generated from the server code."',
    'sidebar:',
    '  label: "MCP tools"',
    '  order: 2',
    '---',
    '',
    '<!-- Generated from apps/api/src/mcp/tools.ts by `pnpm -F @superpipeline/docs-check reference`. Do not edit by hand: CI fails when this file differs from what the generator writes. -->',
    '',
    'The tools an agent is offered at `/mcp`, recorded from the server\'s own registrations — so the argument ' +
      'lists are what `tools/list` returns. A tool whose scope your token lacks is never registered for you. ' +
      'For how the tools fit together, see [MCP tools](/build/mcp/); for scopes, [Authentication](/build/auth/#scopes).',
    '',
    '| tool | scope | hints |',
    '|---|---|---|',
    ...tools.map((t) => `| [\`${t.name}\`](#${t.name}) | ${t.scope ? `\`${t.scope}\`` : 'none'} | ${hints(t.annotations)} |`),
    '',
  ];
  for (const t of tools) {
    const json = z.toJSONSchema(z.object(t.inputSchema), { io: 'input', unrepresentable: 'any' }) as {
      properties?: Record<string, Record<string, unknown>>;
      required?: string[];
    };
    const props = json.properties ?? {};
    const required = new Set(json.required ?? []);
    lines.push(`## ${t.name}`, '', publicText(t.description), '');
    lines.push(`**Scope** ${t.scope ? `\`${t.scope}\`` : 'none — a read, open to any agent token'}. **Hints** ${hints(t.annotations)}.`, '');
    if (Object.keys(props).length === 0) {
      lines.push('Takes no arguments.', '');
      continue;
    }
    lines.push('| argument | type | required |', '|---|---|---|');
    for (const [name, schema] of Object.entries(props)) {
      lines.push(`| \`${name}\` | ${cell(typeOf(schema))} | ${required.has(name) ? 'yes' : 'no'} |`);
    }
    lines.push('');
  }
  return lines.join('\n').replace(/\n+$/, '\n');
}
