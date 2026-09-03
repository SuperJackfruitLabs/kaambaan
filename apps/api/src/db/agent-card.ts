/**
 * An agent's A2A AgentCard, projected from the registry.
 *
 * This is what naming 0006's columns after `AgentSkill` was FOR. `docs/01` already calls AgentCard
 * an agent's capability document, and the charter's layer reference says a capability registry
 * "does not invent a replacement for MCP/OpenAPI/CLI/A2A" — so the card is a projection of these
 * rows, not a translation of them. Nothing is renamed on the way out.
 *
 * **A capability the agent holds that the registry has never seen still appears**, degraded to its
 * key. The card describes the agent, and an agent that routes on a tag whose card omits it would
 * be a card that disagrees with the routing — which is the class of silent mismatch this whole
 * area exists to end. A missing row is a registry gap, not a reason to lie about the agent.
 */
import type { CapabilityRecord } from './capabilities';

/** A2A `AgentSkill`. Field names are the specification's, verbatim. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  examples: string[];
  inputModes: string[];
  outputModes: string[];
}

export interface AgentCard {
  name: string;
  description: string | null;
  version: string;
  skills: AgentSkill[];
  /**
   * The capabilities this agent holds that the workspace's registry has no record of. Empty is
   * the healthy state; a non-empty list is the same diagnostic the Capabilities tab shows, said
   * from the agent's side.
   */
  unregistered: string[];
}

/**
 * A2A requires a `version` on the card. kaambaan versions the CARD SHAPE, not the agent — an
 * agent here has no version of its own and inventing one would be a field that never changes and
 * means nothing. This moves when the projection changes.
 */
export const AGENT_CARD_VERSION = '0.1.0';

export function buildAgentCard(
  agent: { name: string; capabilities: string[] },
  registry: CapabilityRecord[],
): AgentCard {
  const byKey = new Map(registry.map((c) => [c.key, c]));
  const unregistered: string[] = [];

  const skills = agent.capabilities.map((key) => {
    const rec = byKey.get(key);
    if (!rec) {
      unregistered.push(key);
      // Degraded, but present. `id` is the routing tag either way, so a consumer reading the card
      // and a lane matching a claim are comparing the same string.
      return { id: key, name: key, description: null, tags: [], examples: [], inputModes: [], outputModes: [] };
    }
    return {
      id: rec.key,
      name: rec.name,
      description: rec.description,
      tags: rec.tags,
      examples: rec.examples,
      inputModes: rec.inputModes,
      outputModes: rec.outputModes,
    };
  });

  return { name: agent.name, description: null, version: AGENT_CARD_VERSION, skills, unregistered };
}
