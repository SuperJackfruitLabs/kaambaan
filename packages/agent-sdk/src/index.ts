/**
 * @kaambaan/agent-sdk — a minimal, dependency-free client for the Kaambaan agent contract
 * (docs/04 §3). Any harness can use it to claim work and drive a run through the loop; it speaks
 * only the public REST surface. The HTTP `fetch` is injected so it runs anywhere (Workers, Node,
 * or a test runtime) without pulling in environment-specific types.
 *
 * ## This package is not installable
 *
 * It is `private: true`, has no build, and ships raw TypeScript via `main`/`exports` — so it is NOT
 * published to npm and **nothing outside this repo can depend on it**. Inside the repo it resolves
 * as `workspace:*` (apps/api takes it as a devDependency, for tests). An external integrator should
 * read this file as a worked example and then make the same HTTP calls directly; the surface is
 * small and fully specified in docs/05 §3.
 *
 * ## Authentication
 *
 * Agents authenticate with a **`kbn_` bearer token**, minted in the UI ("Connect an agent") and
 * stored server-side only as a SHA-256 hash. That is the way to talk to a deployed Kaambaan:
 *
 * ```ts
 * const agent = new KaambaanAgent({ baseUrl, boardId, token: process.env.KAAMBAAN_TOKEN!, fetch });
 * ```
 *
 * The token carries the tenant, the agent identity, and the agent's registered capabilities, so
 * `tenantId` / `agentId` / `capabilities` are not needed (and are ignored) when a token is set.
 *
 * The legacy `X-Tenant-Id` / `X-Agent-Id` headers remain supported for **local development only**
 * (`wrangler dev --var DEV_AUTH:true`); a deployed server rejects them.
 *
 * ## What a token can reach
 *
 * An agent token authorizes exactly the agent routes: `POST /v1/boards/:id/claims`,
 * `GET /v1/boards/:id/runs/:runId` and `POST /v1/boards/:id/runs/:runId/:action` — i.e. every verb
 * on this client. Board/card administration (creating boards, adding cards, resolving gates) is a
 * human surface behind a session cookie and is deliberately not exposed here.
 */

export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<HttpResponse>;

export interface AgentConfig {
  /** Origin of the Kaambaan deployment, e.g. `https://kaambaan.dev`. */
  baseUrl: string;
  /** The board this agent works. */
  boardId: string;
  /**
   * The agent's `kbn_` bearer token — how agents authenticate. It carries the tenant, the agent
   * identity, and the agent's registered capabilities.
   */
  token?: string;
  /** Dev only (`DEV_AUTH=true`): the tenant, when no token is set. Ignored when `token` is set. */
  tenantId?: string;
  /** Dev only: the claiming agent's id, when no token is set. Ignored when `token` is set. */
  agentId?: string;
  /** Dev only: capabilities to match on. With a token the server uses the agent's registered ones. */
  capabilities?: string[];
  maxConcurrency?: number;
  fetch: Fetcher;
}

export interface ClaimedWork {
  runId: string;
  leaseEpoch: number;
  card: { id: string; title: string; currentStageKey: string };
  stage: { key: string; name: string };
  handoff: unknown;
}

/**
 * What an agent may read: the context of a run it owns (docs/04 §3 `getCard`). Deliberately not a
 * board view — the whole-board snapshot is a human surface.
 */
export interface RunContext {
  run: {
    runId: string;
    cardId: string;
    stageKey: string;
    leaseEpoch: number;
    status: string;
    outcome: string | null;
    startedAt: string;
    endedAt: string | null;
  };
  card: { id: string; title: string; spec: unknown; currentStageKey: string; state: string };
  stage: { key: string; name: string } | null;
  handoff: unknown;
  references: Array<{ id: string; url: string; title: string | null; provider: string; sourceType: string }>;
  /** The questions this run asked a human, oldest first, each with its answer once one is given. */
  elicitations: Elicitation[];
}

/** A choice offered to a human on an elicitation. `name` is what an answer comes back as. */
export interface ElicitationOption {
  name: string;
  title: string;
  promptFill?: string;
  interactive?: boolean;
}

/**
 * A question this run asked a human (docs/04 §4). It is `pending` until someone answers; the card
 * waits in `input-required` and this run keeps its lease throughout, so the agent resumes as itself
 * rather than re-claiming. `cancelled` means the question outlived its run or its card and will
 * never be answered — stop waiting.
 */
export interface Elicitation {
  id: string;
  cardId: string;
  runId: string;
  stageKey: string;
  agentId: string;
  question: string;
  signal: string | null;
  options: ElicitationOption[];
  status: 'pending' | 'answered' | 'cancelled';
  answer: { option: string | null; text: string | null; answeredBy: string; answeredAt: string } | null;
  createdAt: string;
}

export interface AgentActivity {
  type: 'thought' | 'action' | 'response' | 'elicitation' | 'error';
  body?: string;
  action?: string;
  ephemeral?: boolean;
  signal?: string;
  /**
   * The structured payload that goes with the activity — an `action`'s arguments, and an
   * `elicitation`'s selectable `options`. This is the one carrier the board reads and hands back.
   */
  parameter?: unknown;
}

interface ClaimResponse {
  claimed: boolean;
  runId?: string;
  leaseEpoch?: number;
  card?: ClaimedWork['card'];
  stage?: ClaimedWork['stage'];
  handoff?: unknown;
}

/** A request the server refused (auth, validation, conflict) — carries the HTTP status. */
export class KaambaanApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'KaambaanApiError';
  }
}

/** Best-effort human-readable reason from an error response (`{ error }` or `{ error: { message } }`). */
async function errorMessage(res: HttpResponse, path: string, method = 'POST'): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { error?: string | { message?: string } };
    detail = typeof body.error === 'string' ? body.error : (body.error?.message ?? '');
  } catch {
    // non-JSON body — the status is enough
  }
  return `${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ''}`;
}

/** A small client for the Kaambaan agent contract. One instance works one board as one agent. */
export class KaambaanAgent {
  constructor(private readonly config: AgentConfig) {
    if (config.token) {
      if (!config.token.startsWith('kbn_')) {
        throw new Error('KaambaanAgent: token must be a Kaambaan agent token ("kbn_…"), minted via Connect an agent');
      }
    } else if (!config.tenantId) {
      throw new Error(
        'KaambaanAgent: a `token` ("kbn_…") is required. `tenantId`/`agentId` headers only work against a local server run with DEV_AUTH=true.',
      );
    }
  }

  /**
   * Auth for every request: the bearer token when configured, otherwise the dev headers. The two
   * are never mixed — a token supersedes any tenant/agent the caller also passed.
   */
  private headers(): Record<string, string> {
    const base = { 'Content-Type': 'application/json' };
    if (this.config.token) return { ...base, Authorization: `Bearer ${this.config.token}` };
    const dev: Record<string, string> = { ...base, 'X-Tenant-Id': this.config.tenantId! };
    if (this.config.agentId) dev['X-Agent-Id'] = this.config.agentId;
    return dev;
  }

  private post(path: string, body: unknown): Promise<HttpResponse> {
    return this.config.fetch(`${this.config.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }

  /**
   * Claim the next ready card matching this agent, or null when none is available.
   *
   * Throws {@link KaambaanApiError} when the server refuses the request — a rejected token must
   * not be indistinguishable from "no work available".
   */
  async claim(): Promise<ClaimedWork | null> {
    const path = `/v1/boards/${this.config.boardId}/claims`;
    const res = await this.post(path, {
      capabilities: this.config.capabilities,
      maxConcurrency: this.config.maxConcurrency,
    });
    if (!res.ok) throw new KaambaanApiError(res.status, path, await errorMessage(res, path));
    const body = (await res.json()) as ClaimResponse;
    if (!body.claimed || !body.runId || body.leaseEpoch === undefined || !body.card || !body.stage) {
      return null;
    }
    return {
      runId: body.runId,
      leaseEpoch: body.leaseEpoch,
      card: body.card,
      stage: body.stage,
      handoff: body.handoff ?? null,
    };
  }

  /**
   * Re-read the context of a run this agent owns — the card it holds, that card's current stage,
   * the upstream handoff and the card's references. The claim already returns this; use it to
   * resume after a restart, or to observe where the card landed once the run has ended.
   *
   * Throws {@link KaambaanApiError} on 403 (the run is another agent's) or 404 (no such run).
   */
  async context(work: ClaimedWork | string): Promise<RunContext> {
    const runId = typeof work === 'string' ? work : work.runId;
    const path = `/v1/boards/${this.config.boardId}/runs/${runId}`;
    const res = await this.config.fetch(`${this.config.baseUrl}${path}`, { method: 'GET', headers: this.headers() });
    if (!res.ok) throw new KaambaanApiError(res.status, path, await errorMessage(res, path, 'GET'));
    return (await res.json()) as RunContext;
  }

  private run(work: ClaimedWork, action: string, extra: Record<string, unknown> = {}): Promise<HttpResponse> {
    return this.post(`/v1/boards/${this.config.boardId}/runs/${work.runId}/${action}`, {
      leaseEpoch: work.leaseEpoch,
      ...extra,
    });
  }

  heartbeat(work: ClaimedWork): Promise<HttpResponse> {
    return this.run(work, 'heartbeat');
  }
  activity(work: ClaimedWork, activity: AgentActivity): Promise<HttpResponse> {
    return this.run(work, 'activities', { ...activity });
  }
  complete(work: ClaimedWork, handoff?: unknown): Promise<HttpResponse> {
    return this.run(work, 'complete', { handoff });
  }
  block(work: ClaimedWork, reason: string): Promise<HttpResponse> {
    return this.run(work, 'block', { reason });
  }
  fail(work: ClaimedWork, reason: string): Promise<HttpResponse> {
    return this.run(work, 'fail', { reason });
  }
  release(work: ClaimedWork): Promise<HttpResponse> {
    return this.run(work, 'release');
  }

  /**
   * Ask the human a question and stop on it — the move for a decision the agent may not take alone
   * (a permission prompt, a choice between paths). The card parks in `input-required` (or
   * `auth-required` with `signal: 'auth'`), **this run keeps its lease**, and the returned
   * elicitation is what an answer will be attached to.
   *
   * `options` are the answers offered; they travel in the activity's `parameter`. Omit them for an
   * open question. Keep heartbeating while you wait — a question does not pause the heartbeat
   * timeout, and an agent that goes quiet has its run reclaimed like any other.
   *
   * ```ts
   * const asked = await agent.ask(work, 'May I run the test suite?', {
   *   options: [{ name: 'run', title: 'Run them' }, { name: 'skip', title: 'Skip them' }],
   * });
   * for (;;) {
   *   await agent.heartbeat(work);
   *   const [q] = (await agent.elicitations(work)).filter((e) => e.id === asked.id);
   *   if (q?.status === 'answered') return q.answer;      // resume with the decision
   *   if (q?.status !== 'pending') return null;           // cancelled — the card moved on
   *   await sleep(5_000);
   * }
   * ```
   */
  async ask(
    work: ClaimedWork,
    question: string,
    opts: { options?: ElicitationOption[]; signal?: string } = {},
  ): Promise<Elicitation> {
    const path = `/v1/boards/${this.config.boardId}/runs/${work.runId}/activities`;
    const res = await this.run(work, 'activities', {
      type: 'elicitation',
      body: question,
      signal: opts.signal ?? (opts.options && opts.options.length > 0 ? 'select' : undefined),
      parameter: opts.options ? { options: opts.options } : undefined,
    });
    if (!res.ok) throw new KaambaanApiError(res.status, path, await errorMessage(res, path));
    // The activity response acknowledges the post; the question itself (with its id) comes back on
    // the run — the same read the agent polls for the answer, so there is one shape to handle.
    const asked = (await this.elicitations(work)).at(-1);
    if (!asked) throw new KaambaanApiError(res.status, path, `${path} accepted the question but the run has none`);
    return asked;
  }

  /** The questions this run asked, oldest first — poll this to collect a human's answer. */
  async elicitations(work: ClaimedWork | string): Promise<Elicitation[]> {
    return (await this.context(work)).elicitations;
  }
}

export type WorkHandler = (work: ClaimedWork, agent: KaambaanAgent) => Promise<unknown | void>;

/**
 * Reference driver: claim one card, acknowledge, run the work via `handler`, and complete it.
 * Returns true if a card was worked, false if there was nothing to claim. This is the loop a
 * real harness (Claude Code, Codex, …) wraps around its own execution.
 */
export async function runOnce(agent: KaambaanAgent, handler: WorkHandler): Promise<boolean> {
  const work = await agent.claim();
  if (!work) return false;
  await agent.heartbeat(work);
  await agent.activity(work, { type: 'thought', body: `working on "${work.card.title}"`, ephemeral: true });
  try {
    const handoff = await handler(work, agent);
    await agent.complete(work, handoff ?? undefined);
  } catch (err) {
    // Free the card immediately rather than waiting for the heartbeat-timeout reclaim.
    await agent.fail(work, err instanceof Error ? err.message : String(err));
    throw err;
  }
  return true;
}
