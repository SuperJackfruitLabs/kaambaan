/**
 * Kaambaan MCP tools (docs/05 §2). Each tool maps 1:1 onto a contract verb and calls the *same*
 * Board Durable Object method the REST surface calls (apps/api/src/index.ts) — so MCP and REST are
 * the same contract, projected onto two wires (parity is proven by mcp-parity.test.ts).
 *
 * Business failures come back as `isError: true` (model-visible, self-correctable). Transport-level
 * errors (bad args, unknown tool) are handled by the SDK. Agent identity (agentId, capabilities,
 * tenant) comes from the authenticated token — never from tool arguments.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { BoardStub, Result, JsonValue, AgentActivityType } from '../board/board-do';
import { resolveReferenceInput } from '../references/resolve';

/** The principal resolved from the bearer token (the OAuth Resource Server side, docs/05 §2). */
export interface McpAuth {
  tenantId: string;
  agentId: string;
  capabilities: string[];
}

export interface ToolDeps {
  auth: McpAuth;
  /** Build a Board DO stub for (tenant, board) — identical to the Worker's `boardStub` helper. */
  boardStub: (boardId: string) => BoardStub;
  /** List the boards in the caller's workspace (for the work-discovery tool). */
  listBoards: () => Promise<Array<{ id: string; name: string }>>;
}

const ok = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

const fail = (code: string, message: string): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  isError: true,
});

/** Map a Board DO `Result<T>` onto an MCP tool result: value on success, isError on business failure. */
const fromResult = <T>(r: Result<T>): CallToolResult => (r.ok ? ok(r.value) : fail(r.code, r.message));

const json = z.record(z.string(), z.unknown());

export function registerKaambaanTools(server: McpServer, deps: ToolDeps): void {
  const { auth } = deps;

  server.registerTool(
    'kaambaan_list_work',
    {
      description:
        'Discover where there is work for you: lists the boards in your workspace with how many cards are ' +
        'ready for your capabilities right now. Start here to find a boardId, then call kaambaan_claim_card. ' +
        'Returns { capabilities, boards: [{ boardId, name, readyForYou }] }.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const boards = await deps.listBoards();
      const work = await Promise.all(
        boards.map(async (b) => ({
          boardId: b.id,
          name: b.name,
          readyForYou: await deps.boardStub(b.id).countReadyForCapabilities(auth.agentId, auth.capabilities),
        })),
      );
      return ok({ capabilities: auth.capabilities, boards: work });
    },
  );

  server.registerTool(
    'kaambaan_claim_card',
    {
      description:
        'Claim the next ready card you are eligible to work, using your token\'s capabilities. ' +
        'Returns a run + lease + the upstream handoff, or {claimed:false} when no work is available.',
      inputSchema: { boardId: z.string(), maxConcurrency: z.number().int().positive().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ boardId, maxConcurrency }) => {
      const claim = await deps.boardStub(boardId).claim({
        agentId: auth.agentId,
        capabilities: auth.capabilities,
        maxConcurrency,
      });
      return ok(claim);
    },
  );

  server.registerTool(
    'kaambaan_get_card',
    {
      description: 'Read a card by id (title, current stage, state).',
      inputSchema: { boardId: z.string(), cardId: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ boardId, cardId }) => {
      const card = (await deps.boardStub(boardId).getState()).cards.find((c) => c.id === cardId);
      return card ? ok(card) : fail('CARD_NOT_FOUND', `card ${cardId} not found`);
    },
  );

  server.registerTool(
    'kaambaan_add_reference',
    {
      description:
        'Attach a first-class external reference (GitHub PR/issue, repo, doc, or any url) to a card. ' +
        'Idempotent on (card, url); a bare GitHub url is auto-recognized into provider/sourceType/externalId.',
      inputSchema: {
        boardId: z.string(),
        cardId: z.string(),
        url: z.string().min(1),
        provider: z.string().optional(),
        sourceType: z.string().optional(),
        title: z.string().optional(),
        subtitle: z.string().optional(),
        externalId: z.string().optional(),
        metadata: json.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ boardId, cardId, url, provider, sourceType, title, subtitle, externalId, metadata }) =>
      fromResult(
        await deps.boardStub(boardId).addReference(
          resolveReferenceInput({ cardId, url, provider, sourceType, title, subtitle, externalId, metadata, addedBy: 'agent' }),
        ),
      ),
  );

  server.registerTool(
    'kaambaan_heartbeat',
    {
      description: 'Renew your lease on an active run so it is not reclaimed (docs/08).',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ boardId, runId, leaseEpoch }) =>
      fromResult(await deps.boardStub(boardId).heartbeat({ runId, leaseEpoch, agentId: auth.agentId })),
  );

  server.registerTool(
    'kaambaan_post_activity',
    {
      description: 'Stream a typed activity (thought/action/response/elicitation/error) onto the run.',
      inputSchema: {
        boardId: z.string(),
        runId: z.string(),
        leaseEpoch: z.number().int().min(0),
        type: z.enum(['thought', 'action', 'response', 'elicitation', 'error']),
        ephemeral: z.boolean().optional(),
        body: z.string().optional(),
        action: z.string().optional(),
        parameter: z.unknown().optional(),
        result: z.unknown().optional(),
        signal: z.string().optional(),
        usage: z
          .object({
            model: z.string().optional(),
            inputTokens: z.number().int().min(0).optional(),
            outputTokens: z.number().int().min(0).optional(),
            costUsd: z.number().min(0).optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, type, ephemeral, body, action, parameter, result, signal, usage }) =>
      fromResult(
        await deps.boardStub(boardId).postActivity({
          runId,
          leaseEpoch,
          agentId: auth.agentId,
          type: type as AgentActivityType,
          ephemeral,
          body,
          action,
          parameter: parameter as JsonValue,
          result: result as JsonValue,
          signal,
          usage,
        }),
      ),
  );

  server.registerTool(
    'kaambaan_submit_for_review',
    {
      description: 'Submit your work at a gated stage for human review (opens an approval gate).',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0), output: json.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, output }) =>
      fromResult(await deps.boardStub(boardId).submitForReview({ runId, leaseEpoch, agentId: auth.agentId, output: output as JsonValue })),
  );

  server.registerTool(
    'kaambaan_complete',
    {
      description: 'Finish your run successfully; the card advances to the next stage carrying your handoff.',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0), handoff: json.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, handoff }) =>
      fromResult(await deps.boardStub(boardId).complete({ runId, leaseEpoch, agentId: auth.agentId, handoff: handoff as JsonValue })),
  );

  server.registerTool(
    'kaambaan_block',
    {
      description: 'Mark the run blocked on an external dependency; releases the lease.',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0), reason: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, reason }) =>
      fromResult(await deps.boardStub(boardId).block({ runId, leaseEpoch, agentId: auth.agentId, reason })),
  );

  server.registerTool(
    'kaambaan_release',
    {
      description: 'Voluntarily give the card back to the queue without failing it.',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0), reason: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, reason }) =>
      fromResult(await deps.boardStub(boardId).release({ runId, leaseEpoch, agentId: auth.agentId, reason })),
  );

  server.registerTool(
    'kaambaan_fail',
    {
      description: 'Fail the run (counts toward the circuit breaker); the card returns to the queue or trips.',
      inputSchema: { boardId: z.string(), runId: z.string(), leaseEpoch: z.number().int().min(0), reason: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ boardId, runId, leaseEpoch, reason }) =>
      fromResult(await deps.boardStub(boardId).fail({ runId, leaseEpoch, agentId: auth.agentId, reason })),
  );
}
