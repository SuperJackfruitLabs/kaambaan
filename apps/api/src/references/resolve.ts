/**
 * Turn surface-level reference arguments (from MCP or REST) into the Board DO's `ReferenceInput`,
 * auto-enriching `provider`/`sourceType`/`externalId` from the URL when the caller didn't supply
 * them (docs/06 §1). Shared by both wires so enrichment is identical (REST ≡ MCP).
 *
 * `forgeHost` is the tenant's own Forgejo host, and enrichment of forge URLs depends on it being
 * passed: a caller that omits it gets generic `url` references for its own repositories, silently.
 * That is the cost of not guessing, and it is paid here rather than by mislabelling somebody
 * else's server as the tenant's forge.
 */
import { recognizeReference } from './reference-url';
import type { ReferenceInput, JsonValue } from '../board/board-do';

export interface ReferenceArgs {
  cardId: string;
  url: string;
  provider?: string;
  sourceType?: string;
  title?: string;
  subtitle?: string;
  externalId?: string;
  metadata?: Record<string, unknown>;
  addedBy?: 'agent' | 'user';
}

export function resolveReferenceInput(args: ReferenceArgs, forgeHost?: string | null): ReferenceInput {
  const recognized = recognizeReference(args.url, forgeHost);
  return {
    cardId: args.cardId,
    url: args.url,
    provider: args.provider ?? recognized.provider,
    sourceType: args.sourceType ?? recognized.sourceType,
    externalId: args.externalId ?? recognized.externalId,
    title: args.title,
    subtitle: args.subtitle,
    metadata: args.metadata as JsonValue | undefined,
    addedBy: args.addedBy ?? 'agent',
  };
}
