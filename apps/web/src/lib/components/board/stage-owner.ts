/**
 * Who works a lane, under its name.
 *
 * The board showed seven stage names and nothing about who any of them were for. Routing is exact
 * string equality between a stage's capability and an agent's, so "which agent picks this up" was a
 * question you answered by opening another screen and comparing two lists by eye.
 *
 * And the commonest cause of a card that never moves — a lane whose capability nobody holds — looked
 * exactly like a lane nobody had got to yet. That is the state this exists to surface.
 *
 * **It reports who DECLARES a capability, never who "can claim" it.** The board does not load the
 * implication graph (`/v1/capabilities/implications`), so an agent declaring `code` may effectively
 * hold `review` and this cannot know. Counting declarations is a claim the client can support;
 * "nobody can work this lane" is not, and asserting it would be the kind of confident wrongness that
 * sends somebody looking for a bug in the board.
 */
import type { AgentSummary, Stage } from '../../api';
import { displayAgent } from '../../names';

export interface StageOwnerLabel {
  kind: 'agent' | 'capability' | 'human';
  /** What to render under the stage name. Never empty. */
  label: string;
  /** Agents DECLARING what this lane asks for, by name. Empty for a human stage. */
  declaredBy: string[];
  /** True when a capability lane has no declared holder. See the caveat. */
  undeclared: boolean;
  /** Why `undeclared` is not the same as "nobody can claim it". Empty unless `undeclared`. */
  caveat: string;
}

const CAVEAT =
  'No agent DECLARES this capability. One may still qualify through an implication, which the board does not load — check the capability registry before concluding the lane is unstaffed.';

/** The capabilities a stage asks for, and whether every one or any one is enough. */
function requirement(stage: Stage): { caps: string[]; mode: 'all' | 'any' } {
  const req = stage.requires;
  if (req?.all?.length) return { caps: req.all, mode: 'all' };
  if (req?.any?.length) return { caps: req.any, mode: 'any' };
  // `stage.owner` is the single-capability spelling, and the one almost every board uses.
  return { caps: stage.owner ? [stage.owner] : [], mode: 'any' };
}

export function stageOwner(stage: Stage, agents: AgentSummary[]): StageOwnerLabel {
  if (stage.ownerKind === 'agent') {
    return {
      kind: 'agent',
      // `displayAgent` falls back to a short id: the agents list can lag the board, and a stage can
      // name an agent since deleted. A blank where the owner goes is worse than the id.
      label: displayAgent(stage.owner, agents) || 'an agent',
      declaredBy: [],
      undeclared: false,
      caveat: '',
    };
  }

  if (stage.ownerKind === 'human') {
    return {
      kind: 'human',
      // The stage names no particular person — it cannot, there is no field for one — so saying "a
      // person" is the honest version of the question. A gate is worth distinguishing: it is the one
      // human stage that actively waits on a decision rather than merely being human-owned.
      label: stage.gate === 'approval' ? 'a person · approval' : 'a person',
      declaredBy: [],
      undeclared: false,
      caveat: '',
    };
  }

  const { caps, mode } = requirement(stage);
  if (caps.length === 0) {
    // Malformed rather than unstaffed: a capability lane that asks for nothing. Saying so beats a
    // blank line, and beats implying nobody holds a capability that was never named.
    return { kind: 'capability', label: 'no capability set', declaredBy: [], undeclared: false, caveat: '' };
  }

  const declaredBy = agents
    .filter((a) => {
      const held = a.capabilities ?? [];
      // `all` and `any` are different questions; conflating them would overstate who can work here.
      return mode === 'all' ? caps.every((c) => held.includes(c)) : caps.some((c) => held.includes(c));
    })
    .map((a) => a.name)
    .filter((n): n is string => !!n);

  return {
    kind: 'capability',
    label: caps.join(mode === 'all' ? ' + ' : ' or '),
    declaredBy,
    undeclared: declaredBy.length === 0,
    caveat: declaredBy.length === 0 ? CAVEAT : '',
  };
}
