<script lang="ts">
  import { displayAgent, displayPrincipal } from '$lib/names';
  import { cardProvenance } from '$lib/components/board/card-provenance';
  import { onDestroy } from 'svelte';
  import { groupActivities, isNarrative, defaultOpen, visibleActivities } from '$lib/activity-groups';
  import { stageAccount, formatHandoff } from '$lib/stage-account';
  import { app } from '$lib/stores/app.svelte';
  import {
    getCardActivities,
    getAttempts,
    getEstimate,
    updateCard,
    deleteCard,
    addReference,
    resolveGate,
    answerElicitation,
    archiveCard,
    unarchiveCard,
    addLink,
    removeLink,
    listLinks,
    splitCard,
    getBoard,
    getProject,
    type CardActivities,
    type Attempt,
    type Estimate,
    type GateDecision,
    type CardLinks,
    type LinkKind,
    type Project,
    type Milestone,
  } from '$lib/api';
  import { Button } from '$lib/components/ui/button';
  import { agentColor, initialOf } from '$lib/components/agentColor';
  import { resolveCardLabelsForEdit } from '$lib/components/card-labels';
  import { buildLinkGroups, edgeKey, type RemoveArgs } from '$lib/components/link-groups';
  import { crossBoardNotice, submitAddBlocker, linkRefusalSentence, type LinkKindChoice } from '$lib/components/add-blocker';
  import { resolveProjectName } from '$lib/components/plan/project-lookup';
  import { milestonesForProject, assignmentPatch } from '$lib/components/milestone-picker';

  // ---- derived from store ----
  const cardId = $derived(app.openCardId);
  const card = $derived(cardId ? app.cardById(cardId) : undefined);
  let cardDetail = $state<CardActivities | null>(null);
  /**
   * The gate this card is waiting on, preferring the card's OWN fetch over the board snapshot.
   *
   * The drawer had two sources of truth for one fact: the pending gate came from the board
   * snapshot, the decided ones from `cardDetail`. When those disagree — a gate resolved from
   * another client, a snapshot that has not caught up — the panel offers Approve and Reject for a
   * decision already made, and the server rightly refuses.
   *
   * One source, and it is the card's own record, which carries decided gates too: a gate resolved
   * anywhere drops out of here as soon as the drawer refetches, which since this branch happens on
   * the live feed. The snapshot stays as the fallback for the moment before the first fetch lands,
   * so a freshly opened drawer is not briefly gateless.
   */
  const gate = $derived(
    cardId
      ? (cardDetail?.gates?.find((g) => g.status === 'pending') ?? (cardDetail ? undefined : app.gateForCard(cardId)))
      : undefined,
  );
  const elicitation = $derived(cardId ? app.elicitationForCard(cardId) : undefined);
  const refs = $derived(cardId ? app.referencesForCard(cardId) : []);
  const boardId = $derived(app.boardId);
  const stageName = $derived(
    card && app.board ? (app.board.stages.find((s) => s.key === card.currentStageKey)?.name ?? card.currentStageKey) : '',
  );

  /**
   * Sub-tasks: this card's direct children, read straight off the board's own card list by
   * `parentCardId` — same-board only (`kind: 'parent'` refuses a cross-board edge server-side), so
   * no extra fetch is needed; the children are already in `app.board.cards`.
   */
  const children = $derived(card ? (app.board?.cards ?? []).filter((c) => c.parentCardId === card.id) : []);
  const totalChildren = $derived(children.length);

  // ---- local async state ----
  /**
   * Tool calls are hidden by default.
   *
   * On the card that prompted this, 361 of 366 rows were tool calls and 5 carried anything the
   * agent said. Showing everything by default buries the 1.4% that tells the story inside the
   * 98.6% that does not.
   */
  let showToolCalls = $state(false);
  /** Gates that have been decided — the pending one is rendered by its own control above. */
  const decidedGates = $derived((cardDetail?.gates ?? []).filter((g) => g.status !== 'pending'));
  let drawerAttempts = $state<Attempt[]>([]);
  const activityGroups = $derived(groupActivities(cardDetail?.activities ?? [], drawerAttempts ?? []));
  /**
   * How each run ENDED, and what it attached — keyed by run so a group can show its own foot.
   *
   * The activities say what an agent DID. Until `runs.handoff_json`/`runs.failure_reason` existed
   * there was nowhere to read what it concluded: the handoff was one column on the card, overwritten
   * at every stage, and a failure's reason went to a notification. So a card worked three times
   * showed three lists of actions and the last line of the story.
   */
  const stageEntries = $derived(stageAccount(drawerAttempts ?? [], refs));
  const stageByRun = $derived(new Map(stageEntries.map((e) => [e.runId, e])));

  let cardEstimate = $state<Estimate | null>(null);
  /** Same-board (enforced) and cross-board (advisory) edges touching this card — Task 17a/17d's `GET …/links`. */
  let cardLinks = $state<CardLinks>({ links: [], externalLinks: [] });

  /**
   * Every edge this card has, grouped so the meanings stay distinct (whole-branch review,
   * Important finding): rendering only `blockedBy` left a `relates` edge, or an outgoing `blocks`
   * edge, creatable through the very dialogue below and visible NOWHERE — no row, no error, no way
   * to know it existed or to remove it. `buildLinkGroups` (`$lib/components/link-groups`) is the
   * one place that reads `cardLinks.links`/`cardLinks.externalLinks` for display; nothing here
   * re-derives which edges mean what.
   */
  const linkGroups = $derived(
    card && boardId
      ? buildLinkGroups(boardId, card.id, card.blockedBy, cardLinks.links, cardLinks.externalLinks, (id) => app.cardById(id)?.title ?? id)
      : { blockedBy: [], resolvedBlockedBy: [], blocks: [], relates: [], advisory: [] },
  );
  const hasAnyLink = $derived(
    linkGroups.blockedBy.length > 0 ||
      linkGroups.resolvedBlockedBy.length > 0 ||
      linkGroups.blocks.length > 0 ||
      linkGroups.relates.length > 0 ||
      linkGroups.advisory.length > 0,
  );

  // ---- project / milestone (Step 3) ----
  /**
   * The card's CURRENT project, fetched for display (the project's own name — `resolveProjectName`
   * stays safe without it, but this is also where the card's milestone NAME comes from) and reused
   * as the editor's initial milestone options when editing starts without changing the project.
   *
   * Keyed off `cardProjectId` (a derived primitive), not `card` itself, so this does not refetch on
   * every board refresh while the drawer sits open — only when the id actually changes.
   */
  const cardProjectId = $derived(card?.projectId ?? null);
  let projectDetail = $state<{ project: Project; milestones: Milestone[] } | null>(null);
  $effect(() => {
    const pid = cardProjectId;
    if (!pid) {
      projectDetail = null;
      return;
    }
    void getProject(pid).then((d) => {
      // A dangling projectId (its project was deleted) resolves to `null` here, same as any other
      // stale id (see `Card.projectId`'s own comment) — `projectDetail` just stays null, and the
      // name below falls back to the raw id. Never a thrown error, never a spinner with nothing to
      // wait for.
      projectDetail = d;
    });
  });
  /** Safe against a dangling id — never throws, falls back to the raw id (`project-lookup.ts`). */
  const currentProjectName = $derived(resolveProjectName(cardProjectId, app.projects));
  const currentMilestoneName = $derived(
    card?.milestoneId
      ? (projectDetail?.milestones.find((m) => m.id === card.milestoneId)?.name ?? card.milestoneId)
      : null,
  );

  let editingProject = $state(false);
  let selProjectId = $state('');
  let selMilestoneId = $state('');
  let selProjectMilestones = $state<Milestone[]>([]);
  let savingProject = $state(false);
  let projectAssignError = $state<string | null>(null);

  function startProjectEdit(): void {
    if (!card) return;
    selProjectId = card.projectId ?? '';
    selMilestoneId = card.milestoneId ?? '';
    selProjectMilestones =
      projectDetail && projectDetail.project.id === selProjectId ? milestonesForProject(projectDetail.milestones, selProjectId) : [];
    projectAssignError = null;
    editingProject = true;
  }

  /**
   * The project changed — clear the milestone selection immediately and reload the picker's
   * options to the NEW project's own milestones only.
   *
   * This is the chosen handling for the server's stale-milestone refusal: `PATCH { projectId: B }`
   * on a card still carrying a milestone from project A is refused as `MILESTONE_NOT_IN_PROJECT`
   * (`apps/api/src/index.ts`) even when the request never mentions `milestoneId` at all, because
   * the route recomputes the "effective" pair from the card's current value whenever either half
   * could change. Clearing here — rather than letting the save fail and showing that refusal as a
   * sentence — means the picker never lets a person build a request the server will refuse: the
   * same principle the milestone list itself already follows (`milestonesForProject`, scoped to
   * the chosen project so it never OFFERS a mismatch either).
   */
  async function onProjectSelectChange(): Promise<void> {
    selMilestoneId = '';
    if (!selProjectId) {
      selProjectMilestones = [];
      return;
    }
    const d = await getProject(selProjectId);
    selProjectMilestones = d ? milestonesForProject(d.milestones, selProjectId) : [];
  }

  async function saveProjectAssignment(): Promise<void> {
    if (!boardId || !cardId || !card || savingProject) return;
    savingProject = true;
    projectAssignError = null;
    try {
      const current = { projectId: card.projectId, milestoneId: card.milestoneId };
      const next = { projectId: selProjectId === '' ? null : selProjectId, milestoneId: selMilestoneId === '' ? null : selMilestoneId };
      const patch = assignmentPatch(current, next);
      if (Object.keys(patch).length === 0) {
        editingProject = false;
        return;
      }
      const res = await updateCard(boardId, cardId, patch);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        projectAssignError = linkRefusalSentence(body?.error, res.status);
        return;
      }
      editingProject = false;
      await app.refresh();
    } finally {
      savingProject = false;
    }
  }

  // ---- edit state ----
  let editing = $state(false);
  let editTitle = $state('');
  let editPriority = $state(0);
  let editDesc = $state('');
  let editLabels = $state('');
  /**
   * True when the card carries label ids but the catalogue resolved none of them by name — a
   * stale or failed `app.labels` (finding 2, phase-1 fix wave). `editLabels` reads as empty in
   * that case even though the card is NOT actually unlabelled, and `saveCard` must not write
   * `labelNames` from it: an ordinary save (even title-only — `labelNames` is sent every time)
   * would send `labelNames: []`, which the server reads as "replace with nothing" and silently
   * wipes every label off the card. A UI that cannot see the labels must not be able to delete
   * them.
   */
  let editLabelsBlind = $state(false);
  let editAC = $state('');
  // `dueAt` is its own column (Task 6), not `spec.due` — two sources of truth for one date is
  // the condition that column exists to end.
  let editDue = $state('');
  let savingCard = $state(false);
  let newRefUrl = $state('');
  let localError = $state<string | null>(null);
  /** A refusal from the gate, rendered in the gate panel rather than at the top of the drawer. */
  let gateError = $state<string | null>(null);

  // ---- elicitation (agent question) state ----
  let answerText = $state('');
  let answering = $state(false);

  /**
   * How long a burst of feed events is allowed to collapse into one refetch.
   *
   * A second is well under the interval at which a person perceives a list as stale, and well
   * over the gap between two tool calls in a fast run.
   */
  const FEED_COALESCE_MS = 1000;

  // ---- gate state ----
  // which option is interactive (request_changes) — shows comment textarea
  let activeInteractiveOption = $state<string | null>(null);
  let gateComment = $state('');

  // ---- refresh drawer data when card opens / changes ----
  $effect(() => {
    const id = cardId;
    if (id && boardId) {
      answerText = '';
      gateComment = '';
      gateError = null;
      activeInteractiveOption = null;
      editing = false;
      newRefUrl = '';
      localError = null;
      newSubtaskTitle = '';
      subtaskError = null;
      addBlockerOpen = false;
      blockerError = null;
      editingProject = false;
      projectAssignError = null;
      // The board switcher list — needed to name a cross-board advisory blocker's board, and to
      // populate the Add-blocker dialogue's board picker. Best-effort, same as everywhere else
      // `app.boards` is read: a board the catalogue could not resolve just shows no name.
      void app.loadBoards();
      void refreshDrawer(id, boardId);
    } else {
      cardDetail = null;
      drawerAttempts = [];
      cardEstimate = null;
      cardLinks = { links: [], externalLinks: [] };
    }
  });

  /**
   * Reload the four things the drawer fetches, each on its own terms.
   *
   * It was one `Promise.all` inside a silent catch, which meant ANY of the four failing threw away
   * all four results — so a transient blip on `estimate` froze the activity stream, the attempts and
   * the links as well, with nothing logged and nothing on screen to say so. The panel simply stopped
   * being current while continuing to look it.
   *
   * `allSettled`, and each result applied only if it arrived. A failure now costs exactly the thing
   * that failed, and the other three stay fresh — which matters most for the activity stream, the one
   * a person actually watches.
   */
  async function refreshDrawer(id: string, bid: string): Promise<void> {
    const [acts, atts, est, links] = await Promise.allSettled([
      getCardActivities(bid, id),
      getAttempts(bid, id),
      getEstimate(bid, id),
      listLinks(bid, id),
    ]);
    if (acts.status === 'fulfilled') cardDetail = acts.value;
    if (atts.status === 'fulfilled') drawerAttempts = atts.value;
    if (est.status === 'fulfilled') cardEstimate = est.value;
    if (links.status === 'fulfilled') cardLinks = links.value;
  }

  /**
   * Follow the live feed for THIS card.
   *
   * The effect above runs when the open card changes, which is not when the open card's activity
   * changes. An agent working a card posts one activity per tool call — a real run posted 67 —
   * and every one of them arrives on the board socket; none of them reached this panel, so a
   * person watching a card work saw an empty list until the card moved stage and remounted the
   * drawer. That is what this fixes.
   *
   * Filtered on `payload.cardId` so a busy neighbour costs nothing, and coalesced, because a
   * chatty run would otherwise mean three fetches per tool call. The trailing call matters more
   * than the leading one: the last event in a burst is the one whose data we want.
   */
  let feedTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    const id = cardId;
    const bid = boardId;
    if (!id || !bid) return;

    const stop = app.onFeed((event) => {
      // Events that name another card are not ours. Events that name none — a board rename, a
      // stage change — could still move this card, so they are taken.
      if (event.payload?.cardId && event.payload.cardId !== id) return;
      if (feedTimer !== undefined) return;
      feedTimer = setTimeout(() => {
        feedTimer = undefined;
        void refreshDrawer(id, bid);
      }, FEED_COALESCE_MS);
    });

    return () => {
      stop();
      if (feedTimer !== undefined) clearTimeout(feedTimer);
      feedTimer = undefined;
    };
  });

  // ---- close ----
  function close(): void {
    app.closeCard();
  }

  // ---- edit ----
  function startEdit(): void {
    if (!card) return;
    editTitle = card.title;
    editPriority = card.priority;
    editDesc = (card.spec?.description as string | undefined) ?? '';
    // Names, read back from the catalogue by the ids the card actually carries — `card.labels`
    // (Task 4), not `spec.labels`. The catalogue is already in the store (`app.labels`, fetched at
    // board load), so no extra round trip is needed to show what a person typed before.
    const byName = new Map([...app.labelById()].map(([id, l]) => [id, l.name]));
    const resolved = resolveCardLabelsForEdit(card.labels, byName);
    editLabels = resolved.text;
    editLabelsBlind = resolved.blind;
    const existingAC = Array.isArray(card.spec?.acceptanceCriteria) ? (card.spec!.acceptanceCriteria as string[]) : [];
    editAC = existingAC.join('\n');
    editDue = card.dueAt ?? '';
    editing = true;
  }

  async function saveCard(): Promise<void> {
    if (!boardId || !cardId || editTitle.trim() === '') return;
    savingCard = true;
    try {
      // Names, not ids — resolved against the catalogue server-side (`resolveLabelNames`), which
      // creates whatever does not exist yet rather than refusing it. `spec.labels` is not written:
      // that field is what left the tile's chips permanently empty, since nothing ever wrote
      // `card.labels` (the field the tile actually reads).
      //
      // Omitted entirely (not sent as `[]`) when `editLabelsBlind` — the catalogue could not
      // resolve any of the card's current label ids, so `editLabels` reads as empty even though
      // the card is not actually unlabelled. Sending `labelNames: []` there would tell the server
      // to replace the card's labels with nothing, wiping them from a save that never meant to
      // touch labels at all (finding 2, phase-1 fix wave).
      const labelNames = editLabelsBlind ? undefined : editLabels.split(',').map((l) => l.trim()).filter(Boolean);
      const ac = editAC.split('\n').map((l) => l.trim()).filter(Boolean);
      const spec = {
        ...(card?.spec ?? {}),
        description: editDesc,
        acceptanceCriteria: ac,
      };
      const res = await updateCard(boardId, cardId, {
        title: editTitle.trim(),
        priority: Number(editPriority) || 0,
        spec,
        ...(labelNames !== undefined ? { labelNames } : {}),
        // Empty clears it — null, not an omitted field, so "no due date" is a real write rather
        // than a value the server never hears about.
        dueAt: editDue.trim() === '' ? null : editDue.trim(),
      });
      if (!res.ok) localError = `Couldn't save the card (${res.status})`;
      editing = false;
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      savingCard = false;
    }
  }

  /**
   * Reassign the card.
   *
   * A card's owner was fixed to whoever created it — no reassign, no "assign to me", no unassign —
   * on a board whose whole purpose is handing work between people and agents. Deliberately does
   * NOT touch `queuedBy`: who is answerable for a card and who authorised its dispatch are
   * different questions, and the second is what a claim is checked against.
   */
  let assigning = $state(false);
  async function assignToMe(): Promise<void> {
    if (!boardId || !cardId || !app.user) return;
    assigning = true;
    try {
      const res = await updateCard(boardId, cardId, { ownerUserId: app.user.userId });
      if (!res.ok) localError = `Couldn't reassign the card (${res.status})`;
      await app.refresh();
    } finally {
      assigning = false;
    }
  }

  async function onDeleteCard(): Promise<void> {
    if (!boardId || !cardId) return;
    if (!confirm('Delete this card and its history? This cannot be undone.')) return;
    const res = await deleteCard(boardId, cardId);
    if (res.ok) {
      close();
      await app.refresh();
    } else {
      localError = `Couldn't delete the card (${res.status})`;
    }
  }

  async function addRef(): Promise<void> {
    if (!boardId || !cardId || newRefUrl.trim() === '') return;
    const res = await addReference(boardId, cardId, { url: newRefUrl.trim() });
    if (res.ok) {
      newRefUrl = '';
      await app.refresh();
    } else {
      localError = `Couldn't add that link (${res.status})`;
    }
  }

  // ---- archive (Step 1b) ----
  // A construct a person can see and cannot create is half-built. Phase 1 shipped the
  // `archivedAt` column and a "show archived" filter with no way to ever produce an archived
  // card; this is that write. Sends a real timestamp (`archiveCard`), not a client-side flag.
  let archiving = $state(false);
  async function onArchiveCard(): Promise<void> {
    if (!boardId || !cardId) return;
    if (!confirm('Archive this card? It will drop off the board unless "show archived" is on.')) return;
    archiving = true;
    try {
      const res = await archiveCard(boardId, cardId);
      if (res.ok) {
        close();
        await app.refresh();
      } else {
        localError = `Couldn't archive the card (${res.status})`;
      }
    } finally {
      archiving = false;
    }
  }

  /**
   * Un-archive: whole-branch review, Minor. `board-do.ts:3347` names un-archiving as one of THREE
   * recoveries for a parent parked by an archived child; the other two already had a surface here
   * and this one didn't, so an archived card was a one-way door through the web app even though
   * the route/DO have always accepted `archivedAt: null`. Does not close the drawer — unlike
   * archiving, un-archiving does not drop the card out of the CURRENT view (`passesArchivedFilter`
   * shows an archived card either way once "show archived" is on, which is how this drawer was
   * reached in the first place).
   */
  async function onUnarchiveCard(): Promise<void> {
    if (!boardId || !cardId) return;
    archiving = true;
    try {
      const res = await unarchiveCard(boardId, cardId);
      if (res.ok) {
        await app.refresh();
      } else {
        localError = `Couldn't un-archive the card (${res.status})`;
      }
    } finally {
      archiving = false;
    }
  }

  // ---- sub-tasks (Step 1b) ----
  // "Add sub-task" reuses Task 15's split (one title in, one child out) rather than
  // createCard + addLink('parent'): createCard's wrapper discards its response body, so it
  // cannot hand back the new child's id to link, while split's response already carries it.
  let newSubtaskTitle = $state('');
  let addingSubtask = $state(false);
  let subtaskError = $state<string | null>(null);
  async function addSubtask(): Promise<void> {
    if (!boardId || !cardId || newSubtaskTitle.trim() === '' || addingSubtask) return;
    addingSubtask = true;
    subtaskError = null;
    try {
      const res = await splitCard(boardId, cardId, [newSubtaskTitle.trim()]);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        subtaskError = linkRefusalSentence(body?.error, res.status);
        return;
      }
      newSubtaskTitle = '';
      await app.refresh();
    } finally {
      addingSubtask = false;
    }
  }

  // ---- add blocker (Step 1b) ----
  // Cross-board blockers get a board picker in THIS dialogue, and the advisory notice
  // (`crossBoardNoticeText` below) must say the edge will not be enforced BEFORE the edge is
  // created, not after — a person who asks for a blocker and gets a silent no-op has already
  // been misled by the time any response comes back.
  let addBlockerOpen = $state(false);
  let blockerBoardId = $state('');
  let blockerCardId = $state('');
  let blockerKind = $state<LinkKindChoice>('blocks');
  let blockerBoardCards = $state<{ id: string; title: string }[]>([]);
  let addingBlocker = $state(false);
  let blockerError = $state<string | null>(null);

  /** Computed client-side, from the same board-id comparison the server route makes — no round trip needed. */
  const crossBoardNoticeText = $derived(boardId ? crossBoardNotice(blockerBoardId, boardId) : null);

  function openAddBlocker(): void {
    if (!boardId || !cardId) return;
    addBlockerOpen = true;
    blockerBoardId = boardId;
    blockerCardId = '';
    blockerKind = 'blocks';
    blockerError = null;
    blockerBoardCards = (app.board?.cards ?? []).filter((c) => c.id !== cardId);
  }

  async function onBlockerBoardChange(): Promise<void> {
    blockerCardId = '';
    if (!boardId || !cardId) return;
    if (blockerBoardId === boardId) {
      blockerBoardCards = (app.board?.cards ?? []).filter((c) => c.id !== cardId);
      return;
    }
    if (!blockerBoardId) {
      blockerBoardCards = [];
      return;
    }
    try {
      const snap = await getBoard(blockerBoardId);
      blockerBoardCards = snap.cards;
    } catch {
      blockerBoardCards = [];
    }
  }

  async function onAddBlocker(): Promise<void> {
    if (!boardId || !cardId || !blockerBoardId || !blockerCardId || addingBlocker) return;
    addingBlocker = true;
    blockerError = null;
    try {
      const res = await submitAddBlocker(
        { blockerBoardId, blockerCardId, thisBoardId: boardId, thisCardId: cardId, kind: blockerKind },
        {
          addLink: (bid, from, to, kind, toBoardId) => addLink(bid, from, to, kind as LinkKind, toBoardId),
          // A no-op body: the reactive `crossBoardNoticeText` banner above already shows the
          // notice as soon as a different board is picked, well before this submit even runs.
          // Still routed through `submitAddBlocker` (rather than calling `addLink` directly) so
          // this code path runs through the SAME order-of-operations the unit test asserts —
          // `notify` before `addLink` — instead of a second implementation that could drift from it.
          notify: () => {},
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        blockerError = linkRefusalSentence(body?.error, res.status);
        return;
      }
      addBlockerOpen = false;
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      addingBlocker = false;
    }
  }

  // ---- remove a link (whole-branch review, Important) ----
  // Every group rendered below (`linkGroups`) carries a `remove` field that is EXACTLY the
  // argument tuple `removeLink` takes — computed once, in `buildLinkGroups`, from the edge's own
  // stored from/to/board ids, never reconstructed here. For an advisory row that means `boardId`
  // is the edge's OWN `fromBoardId` (which may not be THIS card's board at all) and `toBoardId`
  // names the other side — the same asymmetric contract `submitAddBlocker` already follows for
  // creation, so removal targets the same store creation would have written to.
  //
  // `removingKeys` is tracked by `edgeKey(args)` — the SAME function every `{#each}` below uses
  // for its own key — rather than a second, hand-rolled string built here. One function computing
  // "what identifies this edge" is what keeps the in-flight tracking and the render key from ever
  // being able to name two different rows the same thing.
  let removingKeys = $state(new Set<string>());
  let linksError = $state<string | null>(null);

  async function onRemoveLink(args: RemoveArgs): Promise<void> {
    const key = edgeKey(args);
    if (removingKeys.has(key)) return;
    removingKeys = new Set(removingKeys).add(key);
    linksError = null;
    try {
      const res = await removeLink(args.boardId, args.fromCardId, args.toCardId, args.kind, args.toBoardId);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        linksError = linkRefusalSentence(body?.error, res.status);
        return;
      }
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      const next = new Set(removingKeys);
      next.delete(key);
      removingKeys = next;
    }
  }

  // ---- gate resolution ----
  async function onResolve(decision: GateDecision): Promise<void> {
    if (!boardId || !gate) return;
    const comment = gateComment.trim() || undefined;
    const res = await resolveGate(boardId, gate.id, decision, comment);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      /**
       * Beside the button, and carrying the status.
       *
       * A reject on a live gate was reported as the button doing nothing at all. Whatever the
       * server answered, the reader never saw it: `localError` renders at the top of the drawer,
       * sixty lines above the gate panel and off-screen on any card with a real spec. The status
       * code is included because the message alone did not distinguish the candidates — a refused
       * decision, an expired session and a gate decided elsewhere are three different problems
       * with three different remedies.
       */
      gateError = body?.error?.message
        ? `${body.error.message} (${res.status})`
        : `Couldn't record that decision (${res.status})`;
      // Whatever refused us knows something this tab does not; the card's own record settles it.
      await Promise.all([app.refresh(), refreshDrawer(cardId!, boardId)]);
      return;
    }
    gateError = null;
    localError = null;
    await app.refresh();
    app.closeCard();
  }

  // ---- answering an agent's question (docs/04 §4) ----
  // The agent is blocked and still holding its lease; the answer is what lets it carry on, so a
  // failure here has to say so rather than quietly leaving the card parked.
  async function onAnswer(option?: string): Promise<void> {
    if (!boardId || !elicitation || answering) return;
    const text = answerText.trim();
    if (!option && text === '') {
      localError = elicitation.options.length > 0 ? 'Pick one of the options.' : 'Type an answer first.';
      return;
    }
    answering = true;
    try {
      const res = await answerElicitation(boardId, elicitation.id, { option, text: text || undefined });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        localError = body?.error?.message ?? `Couldn't send that answer (${res.status})`;
      } else {
        localError = null;
        answerText = '';
      }
      await app.refresh();
      if (cardId && boardId) void refreshDrawer(cardId, boardId);
    } finally {
      answering = false;
    }
  }

  // ---- helpers ----
  function activityMarker(type: string): { glyph: string; cssClass: string } {
    if (type === 'action') return { glyph: '▸', cssClass: 'act-action' };
    if (type === 'response') return { glyph: '◆', cssClass: 'act-response' };
    if (type === 'error') return { glyph: '✕', cssClass: 'act-error' };
    if (type === 'elicitation') return { glyph: '⚑', cssClass: 'act-elicitation' };
    if (type === 'prompt') return { glyph: '✎', cssClass: 'act-response' }; // the human's turn
    return { glyph: '◇', cssClass: 'act-thought' };
  }

  function fmtTime(ts: string): string {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  }

  function fmtUsd(n: number): string {
    return `$${n.toFixed(2)}`;
  }

  // Defense-in-depth: never emit non-http(s) href
  function safeHref(url: string): string | null {
    return /^https?:\/\//i.test(url) ? url : null;
  }

  const SUB_STATE_LABELS: Record<string, string> = {
    draft_pr_open: 'draft',
    pr_open: 'open',
    agent_iterating: 'iterating',
    awaiting_review: 'review',
    merged: 'merged',
    closed: 'closed',
    agent_working: 'working',
    issue_open: 'open',
    issue_closed: 'closed',
  };

  function subStateLabel(ref: (typeof refs)[number]): string | null {
    const s = ref.metadata?.subState;
    return typeof s === 'string' ? (SUB_STATE_LABELS[s] ?? s) : null;
  }

  function refLabel(ref: (typeof refs)[number]): string {
    if (ref.sourceType === 'pull_request') return `PR ${ref.externalId?.split('#')[1] ? `#${ref.externalId.split('#')[1]}` : ''}`.trim();
    if (ref.sourceType === 'issue') return `Issue ${ref.externalId?.split('#')[1] ? `#${ref.externalId.split('#')[1]}` : ''}`.trim();
    if (ref.sourceType === 'repo') return ref.externalId ?? 'repo';
    return ref.title ?? ref.sourceType;
  }

  // plan helpers
  const planItems = $derived(
    Array.isArray(card?.spec?.plan) ? (card!.spec!.plan as Array<{ t: string; done: boolean }>) : null,
  );
  const planDone = $derived(planItems ? planItems.filter((s) => s.done).length : 0);
  const planPct = $derived(planItems && planItems.length > 0 ? Math.round((planDone / planItems.length) * 100) : 0);

  const acceptanceCriteria = $derived(
    Array.isArray(card?.spec?.acceptanceCriteria) ? (card!.spec!.acceptanceCriteria as string[]) : null,
  );

  // cost
  const costPct = $derived(
    card && cardEstimate?.estimatedUsd && cardEstimate.estimatedUsd > 0
      ? Math.min(100, Math.round((card.costUsd / cardEstimate.estimatedUsd) * 100))
      : 0,
  );

  // agent avatar
  const delegateId = $derived(card?.delegateAgentId ?? null);
  const delegateColor = $derived(agentColor(delegateId));
  /**
   * The agent's NAME, then its initial from that name.
   *
   * Both used to be taken from the raw `agt_…`, so the drawer header read
   * `agt_267d3618110a419b · delegate` with an avatar lettered "A" — the `a` of `agt_`, the same
   * letter for every agent on the board. The owner standing next to it has always been resolved
   * through `displayPrincipal`; this was the one site the naming work missed.
   */
  const delegateName = $derived(displayAgent(delegateId, app.agents));
  const delegateInitial = $derived(initialOf(delegateName));

  /**
   * Who asked for this card, and what they were permitted to dispatch when they did.
   *
   * Same function the tile uses. The alternative — a `find()` per component — is the failure
   * `names.ts` was written to end: "the lookup existed and five sites did it the long way or not at
   * all".
   */
  const provenance = $derived(
    card ? cardProvenance(card, app.members, app.agents) : null,
  );

  /**
   * The grant, in words.
   *
   * `queuedGrant` is stored on every card and rendered nowhere, and a card carrying a 55-principal
   * grant is a very different object from one carrying three. Two facts are worth saying: how wide
   * the authority was, and whether it actually covered the agent that ended up working the card —
   * which under enforcement should always be yes, so a no means enforcement is off or the grant was
   * narrowed after the claim.
   */
  const grantSummary = $derived.by(() => {
    if (!provenance) return '';
    if (provenance.grantSize === null) return 'no dispatch authority was recorded';
    if (provenance.grantSize === 0) return 'authorised to dispatch nobody';
    const n = provenance.grantSize;
    const base = `authorised to dispatch ${n} principal${n === 1 ? '' : 's'}`;
    if (provenance.grantCoversDelegate === null) return base;
    return provenance.grantCoversDelegate
      ? `${base}, including the one working it`
      : `${base} — NOT including the one working it`;
  });

  // state pill
  function statePillClass(state: string): string {
    if (state === 'working') return 'statepill statepill-working';
    if (state === 'gate' || gate) return 'statepill statepill-gate';
    if (state === 'done') return 'statepill statepill-done';
    return 'statepill statepill-ready';
  }
  function statePillLabel(state: string): string {
    if (state === 'working') return 'working';
    if (gate) return 'input-required';
    if (state === 'done') return 'completed';
    return 'ready';
  }

  /**
   * Focus, which the drawer had none of.
   *
   * Moved onto the panel rather than onto its first control: a dialog that opens with the close
   * button focused reads as "Close" to a screen-reader user before it reads as anything else, and
   * `aria-labelledby` on a focused panel announces the card instead.
   *
   * The opener is remembered and restored, because sending focus back to the top of the document
   * loses a keyboard user their place on a board that may be many columns wide.
   */
  let panelEl = $state<HTMLElement | null>(null);
  /**
   * The card whose tile opened this, by id rather than by node.
   *
   * Holding the element itself did not survive: the board re-renders while the drawer is open —
   * a socket message is enough — and the stored button is then detached, so focusing it puts
   * focus on `<body>`, which is exactly the state this is meant to prevent. An id can be looked
   * up again against whatever the board has rendered by the time the drawer closes.
   */
  let openerCardId: string | null = null;

  $effect(() => {
    if (card && panelEl) {
      // Recorded on the way IN only: this effect re-runs while the drawer is open — when the
      // card's detail arrives, for one — and by then the focused element is the panel itself.
      openerCardId ??= card.id;
      panelEl.focus();
    }
  });

  /**
   * Restoring focus belongs in `onDestroy`, not in the effect above.
   *
   * The layout mounts this component inside `{#if app.openCardId}`, so closing a card destroys it
   * outright — an effect branch for "the card is gone" never runs, because by then neither the
   * effect nor the component exists. The microtask lets the board finish rendering the tile back
   * before it is asked to take focus.
   */
  onDestroy(() => {
    const id = openerCardId;
    openerCardId = null;
    if (!id || typeof document === 'undefined') return;
    queueMicrotask(() => {
      document.querySelector<HTMLElement>(`[data-card-open="${CSS.escape(id)}"]`)?.focus();
    });
  });

  const FOCUSABLE =
    'a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';

  /** Keep Tab inside the dialog — the definition of modal, and the thing that was missing. */
  function trapTab(e: KeyboardEvent): void {
    if (e.key !== 'Tab' || !panelEl) return;
    const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) {
      // Nothing to move to; holding focus on the panel is better than letting it escape behind.
      e.preventDefault();
      panelEl.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panelEl)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

{#if card}
  <div class="fixed inset-0 z-30 flex justify-end">
    <!-- scrim -->
    <button class="absolute inset-0 bg-black/55" onclick={close} aria-label="Close drawer" tabindex="-1"></button>

    <!-- drawer panel -->
    <!--
      A real dialog.

      It had no role, no `aria-modal`, nothing labelling it, and no focus management at all:
      opening a card left focus on `<body>`, and the first Tab landed on "superpipeline home" —
      the navigation BEHIND the drawer. Its controls, including a gate's approve and reject, were
      reachable only after tabbing through the whole board.
    -->
    <!-- A div, not an `<aside>`: `aside` is a complementary LANDMARK, and a modal dialog is
         not complementary content sitting beside the page — it is the page, until it closes. -->
    <div
      bind:this={panelEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby="drawer-title"
      tabindex="-1"
      onkeydown={trapTab}
      class="bg-surface border-border drawer-in relative flex h-full w-full flex-col border-l shadow-2xl sm:max-w-[520px]">

      <!-- dw-head -->
      <div class="dw-head border-border border-b p-4 pb-3.5 flex-none">
        {#if editing}
          <!-- edit form -->
          <div class="min-w-0 flex-1">
            <div class="eyebrow mb-2">edit card</div>
            <input bind:value={editTitle} placeholder="Title" class="bg-inset border-border focus:border-marigold w-full rounded-[6px] border px-2.5 py-1.5 text-sm outline-none" />
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
                priority
                <input type="number" bind:value={editPriority} class="bg-inset border-border focus:border-marigold w-16 rounded-[5px] border px-1.5 py-1 outline-none" />
              </label>
              <label class="text-muted-foreground mono flex items-center gap-1.5 text-[11px]">
                due
                <input type="date" bind:value={editDue} aria-label="Due date" class="bg-inset border-border focus:border-marigold rounded-[5px] border px-1.5 py-1 outline-none" />
              </label>
              {#if editDue !== ''}
                <button onclick={() => (editDue = '')} class="text-muted-foreground hover:text-foreground mono text-[11px]">clear</button>
              {/if}
            </div>
            <textarea bind:value={editDesc} rows="3" placeholder="Description / brief for the agent…" class="bg-inset border-border focus:border-marigold mt-2 w-full resize-none rounded-[6px] border px-2.5 py-2 text-xs outline-none"></textarea>
            <label for="edit-labels" class="text-muted-foreground mono mt-3 block text-[11px] uppercase tracking-widest">Labels <span class="normal-case">(comma-separated)</span></label>
            <input
              id="edit-labels"
              bind:value={editLabels}
              placeholder="bug, frontend, urgent"
              disabled={editLabelsBlind}
              class="bg-inset border-border focus:border-marigold mt-1 w-full rounded-[6px] border px-2.5 py-1.5 text-xs outline-none disabled:opacity-60"
            />
            {#if editLabelsBlind}
              <p class="text-muted-foreground mono mt-1 text-[10px]">
                Couldn't load this card's labels from the catalogue — editing is disabled so saving does not clear them. Reopen the card to retry.
              </p>
            {/if}
            <label for="edit-ac" class="text-muted-foreground mono mt-3 block text-[11px] uppercase tracking-widest">Acceptance Criteria <span class="normal-case">(one per line)</span></label>
            <textarea
              id="edit-ac"
              bind:value={editAC}
              rows="3"
              placeholder={"User can log in\nError messages are shown\nAll tests pass"}
              class="bg-inset border-border focus:border-marigold mt-1 w-full resize-none rounded-[6px] border px-2.5 py-2 text-xs outline-none"
            ></textarea>
            <div class="mt-2.5 flex gap-1.5">
              <Button size="sm" onclick={saveCard} disabled={savingCard || editTitle.trim() === ''}>{savingCard ? 'Saving…' : 'Save'}</Button>
              <Button size="sm" variant="ghost" onclick={() => (editing = false)}>Cancel</Button>
            </div>
          </div>
        {:else}
          <!-- dw-crumbs row -->
          <div class="dw-crumbs mb-2 flex items-center gap-2">
            <span class="dw-stage eyebrow" style="color:var(--marigold)">{stageName}</span>
            <button onclick={close} class="text-muted-foreground hover:text-foreground hover:bg-accent ml-auto rounded-[7px] p-1" aria-label="Close" title="close (esc)">
              <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>

          <!-- dw-title -->
          <div class="flex items-start gap-2">
            <h2 id="drawer-title" class="wordmark dw-title text-[17px] font-semibold leading-snug flex-1 min-w-0">{card.title}</h2>
            <button onclick={startEdit} aria-label="Edit card" title="Edit card" class="text-muted-foreground hover:text-foreground hover:bg-accent shrink-0 rounded-[7px] p-1.5">
              <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>
          </div>

          <!-- status row -->
          <div class="statusrow mt-2.5 flex flex-wrap items-center gap-2.5">
            <!-- state pill -->
            <span class={statePillClass(card.state)}>{statePillLabel(card.state)}</span>

            <!-- delegate agent -->
            {#if delegateId}
              <span class="delegate inline-flex items-center gap-1.5 font-mono text-[11px]" style="color:var(--muted)">
                <span class="inline-flex size-[18px] items-center justify-center rounded-full text-[9px] font-semibold shrink-0" style="background:{delegateColor};color:#0f1118">{delegateInitial}</span>
                <span title={delegateId}>{delegateName} · delegate</span>
              </span>
            {/if}

            <!-- owner -->
            <span class="delegate inline-flex items-center gap-1 font-mono text-[11px]" style="color:var(--muted)" title={card.ownerUserId}>owner · {displayPrincipal(card.ownerUserId, app.members)}</span>

            <!--
              Queued by — the third identity, and the one that was carried on every card and shown
              nowhere. A reader has to be able to answer all three questions here without opening a
              terminal: who asked for this, who is answerable for it, and who is doing it.

              Shown for a person too, not only for an agent: the row's job is to make the three
              identities legible, and omitting the common case would leave a reader unable to tell
              "a person queued this" from "nobody recorded who did". The violet chip is reserved for
              the agent case, which is the one that needs to be noticed.
            -->
            {#if provenance?.known}
              {#if provenance.byAgent}
                <span class="queuedchip" title={`Queued by ${provenance.queuedByName} — ${grantSummary}`}>
                  {#if provenance.agent?.iconUrl}
                    <img src={provenance.agent.iconUrl} alt="" class="size-4 shrink-0 rounded-full object-cover" />
                  {/if}
                  <span>asked by {provenance.queuedByName}</span>
                </span>
              {:else}
                <span class="delegate inline-flex items-center gap-1 font-mono text-[11px]" style="color:var(--muted)" title={card.queuedBy ?? ''}>asked by · {provenance.queuedByName}</span>
              {/if}
            {/if}
            {#if app.user && card.ownerUserId !== app.user.userId}
              <button
                onclick={() => void assignToMe()}
                disabled={assigning}
                class="text-muted-foreground hover:text-foreground font-mono text-[11px] underline disabled:opacity-40"
              >{assigning ? 'assigning…' : 'assign to me'}</button>
            {/if}

            <!-- live ephemeral -->
            {#if card.state === 'working'}
              <span class="ephemeral inline-flex items-center gap-1.5 font-mono text-[11.5px]" style="color:var(--live)">
                <span class="live-dot"></span>
              </span>
            {/if}
          </div>
        {/if}
      </div>

      <!-- dw-body -->
      <!--
        The drawer renders text nobody on this side wrote: handoffs, tool arguments, references,
        card specs, an agent's own words. Any of it can be one long unbroken token — a URL, a JSON
        blob, a sha, a path — and on a phone one such token pushes the whole panel sideways. The
        rule is set here so a new section cannot forget it; `pre` blocks keep their own scrolling.
      -->
      <div class="dw-body flex-1 min-h-0 overflow-x-hidden overflow-y-auto px-4 py-4 space-y-5" style="overflow-wrap:anywhere">

        {#if localError}
          <p role="alert" class="border-coral/40 text-coral mono rounded-[7px] border px-3 py-2 text-xs" style="background:rgba(255,107,87,.08)">{localError}</p>
        {/if}

        <!-- description from spec -->
        {#if card.spec?.description}
          <section class="sec">
            <div class="sec-h eyebrow">description</div>
            <p class="text-foreground/90 text-sm leading-relaxed whitespace-pre-wrap">{String(card.spec.description)}</p>
          </section>
        {/if}

        <!-- the agent's open question — the card is parked until someone answers it -->
        {#if elicitation}
          <section class="sec">
            <div class="elicitation border rounded-[10px] p-3.5" style="border-color:rgba(255,107,87,.35);background:rgba(255,107,87,.06)">
              <div class="mb-2 flex items-center gap-2">
                <span class="wordmark font-semibold text-sm" style="color:var(--coral)">
                  ⚑ {elicitation.signal === 'auth' ? 'awaiting your sign-in' : 'awaiting your answer'}
                </span>
                <span class="eyebrow ml-auto" title={elicitation.agentId}>{displayAgent(elicitation.agentId, app.agents)} is waiting</span>
              </div>
              <p class="mb-3 text-[13px] leading-relaxed whitespace-pre-wrap">{elicitation.question}</p>

              {#if elicitation.options.length > 0}
                <div class="flex flex-wrap gap-2">
                  {#each elicitation.options as opt (opt.name)}
                    <Button size="sm" variant={opt.name === elicitation.options[0]?.name ? 'default' : 'outline'} disabled={answering} onclick={() => onAnswer(opt.name)}>
                      {opt.title}
                    </Button>
                  {/each}
                </div>
                <textarea
                  bind:value={answerText}
                  rows="2"
                  placeholder="Add a note for the agent (optional)…"
                  class="bg-inset border-border mt-2.5 w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                  style="border-color:rgba(255,107,87,.4)"
                ></textarea>
              {:else}
                <textarea
                  bind:value={answerText}
                  rows="3"
                  placeholder="Your answer — this goes straight back to the waiting agent…"
                  class="bg-inset border-border w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                  style="border-color:rgba(255,107,87,.4)"
                ></textarea>
                <div class="mt-2 flex justify-end">
                  <Button size="sm" disabled={answering} onclick={() => onAnswer()}>Send answer</Button>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- gate panel — only when a pending gate exists -->
        {#if gate}
          {@const effectiveOptions = gate.options.length > 0
            ? gate.options
            : [
                { name: 'approve', title: 'Approve', interactive: false },
                { name: 'request_changes', title: 'Request changes', interactive: true },
                { name: 'reject', title: 'Reject', interactive: false },
              ]}
          <section class="sec">
            <div class="gate border rounded-[10px] p-3.5" style="border-color:rgba(255,107,87,.35);background:rgba(255,107,87,.06)">
              <div class="gh mb-2.5 flex items-center gap-2">
                <span class="wordmark font-semibold text-sm" style="color:var(--coral)">⚑ awaiting your review</span>
              </div>

              {#if gateError}
                <p role="alert" class="border-coral/40 text-coral mono mb-2.5 rounded-[7px] border px-3 py-2 text-xs" style="background:rgba(255,107,87,.12)">
                  {gateError}
                </p>
              {/if}

              {#if gateError}
                <p role="alert" class="border-coral/40 text-coral mono mb-2.5 rounded-[7px] border px-3 py-2 text-xs" style="background:rgba(255,107,87,.12)">
                  {gateError}
                </p>
              {/if}

              <!-- gate action buttons — driven by effectiveOptions -->
              <div class="triad flex gap-2 flex-wrap">
                {#each effectiveOptions as opt (opt.name)}
                  {#if opt.name === 'approve'}
                    <Button
                      size="sm"
                      onclick={() => onResolve('approve')}
                      class="flex-1"
                    >{opt.title}</Button>
                  {:else if opt.name === 'request_changes'}
                    <Button
                      size="sm"
                      variant="outline"
                      onclick={() => {
                        activeInteractiveOption = activeInteractiveOption === 'request_changes' ? null : 'request_changes';
                      }}
                      class="flex-1"
                    >{opt.title}</Button>
                  {:else if opt.name === 'reject'}
                    <Button
                      size="sm"
                      variant="ghost"
                      onclick={() => onResolve('reject')}
                      class="flex-1"
                    >{opt.title}</Button>
                  {/if}
                {/each}
              </div>

              <!-- request_changes comment box -->
              {#if activeInteractiveOption === 'request_changes'}
                <div class="reject-box mt-3">
                  <textarea
                    bind:value={gateComment}
                    rows="3"
                    placeholder="What needs to change? This feedback threads into the agent's next attempt…"
                    class="bg-inset border-border focus:border-coral w-full resize-none rounded-[7px] border px-2.5 py-2 text-xs outline-none"
                    style="border-color:rgba(255,107,87,.4)"
                  ></textarea>
                  <div class="mt-2 flex justify-end gap-1.5">
                    <Button size="sm" variant="ghost" onclick={() => { activeInteractiveOption = null; gateComment = ''; }}>Cancel</Button>
                    <Button size="sm" variant="outline" onclick={() => onResolve('request_changes')}>Send feedback</Button>
                  </div>
                </div>
              {/if}
            </div>
          </section>
        {/if}

        <!-- plan checklist (from card.spec.plan) -->
        {#if planItems && planItems.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow flex items-center gap-2">
              agent plan
              <span class="ml-auto" style="color:var(--live)">{planPct}%</span>
            </div>
            <div class="plan flex flex-col gap-0.5">
              {#each planItems as step, i (i)}
                <div class="step flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 text-sm {step.done ? 'step-done' : ''}">
                  <span class="step-box flex size-4 shrink-0 items-center justify-center rounded-[5px] border text-[10px] {step.done ? 'step-box-done' : 'border-border'}">
                    {#if step.done}✓{/if}
                  </span>
                  <span class="step-t {step.done ? 'text-muted-foreground line-through' : ''}">{step.t}</span>
                </div>
              {/each}
            </div>
            <!-- rollup bar -->
            <div class="rollup mt-2 h-[5px] overflow-hidden rounded-full bg-inset">
              <div class="h-full rounded-full transition-all duration-1000" style="width:{planPct}%;background:var(--live)"></div>
            </div>
            <div class="eyebrow mt-1.5">{planDone} / {planItems.length} steps · {planPct}%</div>
          </section>
        {/if}

        <!-- acceptance criteria (from card.spec.acceptanceCriteria) -->
        {#if acceptanceCriteria && acceptanceCriteria.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">acceptance criteria</div>
            <ul class="ac bg-inset border-border list-disc rounded-[7px] border px-4 py-3 text-[12.5px] space-y-1">
              {#each acceptanceCriteria as criterion, i (i)}
                <li style="color:var(--text)">{criterion}</li>
              {/each}
            </ul>
          </section>
        {/if}

        <!--
          Project / milestone (Step 3) — a card's cross-board membership. `currentProjectName` and
          `currentMilestoneName` are both total: a dangling id (its project/milestone was deleted)
          shows the raw id rather than throwing or spinning forever (see `project-lookup.ts`).
        -->
        <section class="sec">
          <div class="sec-h eyebrow">project</div>
          {#if editingProject}
            <div class="bg-inset border-border space-y-2 rounded-[8px] border p-3 text-xs">
              <div>
                <label for="assign-project" class="text-muted-foreground mono mb-1 block text-[11px] uppercase tracking-widest">Project</label>
                <select
                  id="assign-project"
                  bind:value={selProjectId}
                  onchange={() => void onProjectSelectChange()}
                  class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none"
                >
                  <option value="">No project</option>
                  {#each app.projects as p (p.id)}
                    <option value={p.id}>{p.name}</option>
                  {/each}
                </select>
              </div>
              <div>
                <!--
                  Scoped to the chosen project ONLY (`milestonesForProject`) — the server refuses a
                  milestone that does not belong to the card's project (`MILESTONE_NOT_IN_PROJECT`),
                  so this picker never offers one it would refuse.
                -->
                <label for="assign-milestone" class="text-muted-foreground mono mb-1 block text-[11px] uppercase tracking-widest">Milestone</label>
                <select
                  id="assign-milestone"
                  bind:value={selMilestoneId}
                  disabled={selProjectId === ''}
                  class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none disabled:opacity-50"
                >
                  <option value="">No milestone</option>
                  {#each selProjectMilestones as m (m.id)}
                    <option value={m.id}>{m.name}</option>
                  {/each}
                </select>
              </div>
              <div class="flex gap-1.5">
                <Button size="sm" onclick={() => void saveProjectAssignment()} disabled={savingProject}>{savingProject ? 'Saving…' : 'Save'}</Button>
                <Button size="sm" variant="ghost" onclick={() => (editingProject = false)}>Cancel</Button>
              </div>
              {#if projectAssignError}
                <p role="alert" class="text-coral mono text-[11px]">{projectAssignError}</p>
              {/if}
            </div>
          {:else}
            <div class="flex flex-wrap items-center gap-2 text-[12px]">
              {#if currentProjectName}
                <span class="mono">{currentProjectName}</span>
                {#if currentMilestoneName}<span class="text-muted-foreground">· {currentMilestoneName}</span>{/if}
              {:else}
                <span class="text-muted-foreground">No project</span>
              {/if}
              <button onclick={startProjectEdit} class="text-muted-foreground hover:text-foreground mono text-[11px] underline underline-offset-2">
                {currentProjectName ? 'change' : 'assign'}
              </button>
            </div>
          {/if}
        </section>

        <!--
          Links (whole-branch review, Important finding) — EVERY edge this card has, in five
          groups that never share a row style, because a person could otherwise create a `relates`
          edge or an outgoing `blocks` edge through the dialogue below and never see it rendered
          anywhere: what blocks this card (enforced, ⛔), what blocked it but has since resolved,
          what this card blocks, what it merely relates to, and the advisory cross-board ones —
          each with its own "remove" control, since `removeLink` (Task 17a) had shipped with zero
          callers in this app.

          Every `{#each}` below is keyed by `edgeKey(row.remove)` — the EDGE's own identity, never
          `row.cardId`/`row.boardId` alone. See `edgeKey`'s own doc comment (`link-groups.ts`) for
          why: two edges can legitimately name the same "other card" (mutual `relates`, since
          `wouldCycle` excludes it from the cycle check), and a key that collides is not a cosmetic
          bug — Svelte 5 throws on a duplicate `{#each}` key, which fails this whole section's
          render. No test in this project can reach that failure directly (Vitest cannot import a
          `.svelte` file here), which is exactly why the reasoning has to live here, not only in a
          function nobody reading this template is forced to open.
        -->
        <section class="sec">
          <div class="sec-h eyebrow">links</div>

          {#if linkGroups.blockedBy.length > 0}
            <div class="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-widest">blocked by</div>
            <div class="mb-2.5 space-y-1.5">
              {#each linkGroups.blockedBy as row (edgeKey(row.remove))}
                {@const key = edgeKey(row.remove)}
                <div class="bg-inset border-border mono flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]" title={row.badge.tooltip}>
                  <span class="blk-pill">{row.badge.glyph}</span>
                  <span class="min-w-0 flex-1 truncate">{row.title}</span>
                  <button onclick={() => void onRemoveLink(row.remove)} disabled={removingKeys.has(key)} class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50">
                    {removingKeys.has(key) ? '…' : 'remove'}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if linkGroups.resolvedBlockedBy.length > 0}
            <!--
              Re-review N2: `blockedBy` only ever carries UNRESOLVED inbound blockers (the claim
              query's own predicate) — a blocker that has since completed drops out of it, but the
              edge itself is never deleted, so it was previously visible in NEITHER group. Shown
              here as resolved, never `⛔`: nothing is currently enforcing it, and re-opening the
              blocker (`moveCard` sets a card back to `submitted` unconditionally) would silently
              re-arm an edge its owner never saw — this is where they can see and clear it first.
            -->
            <div class="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-widest">blocked by (resolved)</div>
            <div class="mb-2.5 space-y-1.5">
              {#each linkGroups.resolvedBlockedBy as row (edgeKey(row.remove))}
                {@const key = edgeKey(row.remove)}
                <div class="bg-inset border-border mono flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]" title="{row.title} blocked this card — resolved, no longer enforced">
                  <span class="min-w-0 flex-1 truncate">{row.title}</span>
                  <button onclick={() => void onRemoveLink(row.remove)} disabled={removingKeys.has(key)} class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50">
                    {removingKeys.has(key) ? '…' : 'remove'}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if linkGroups.blocks.length > 0}
            <div class="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-widest">blocks</div>
            <div class="mb-2.5 space-y-1.5">
              {#each linkGroups.blocks as row (edgeKey(row.remove))}
                {@const key = edgeKey(row.remove)}
                <div class="bg-inset border-border mono flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]">
                  <span class="min-w-0 flex-1 truncate">{row.title}</span>
                  <button onclick={() => void onRemoveLink(row.remove)} disabled={removingKeys.has(key)} class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50">
                    {removingKeys.has(key) ? '…' : 'remove'}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if linkGroups.relates.length > 0}
            <div class="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-widest">relates to</div>
            <div class="mb-2.5 space-y-1.5">
              {#each linkGroups.relates as row (edgeKey(row.remove))}
                {@const key = edgeKey(row.remove)}
                <div class="bg-inset border-border mono flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]">
                  <span class="min-w-0 flex-1 truncate">{row.title}</span>
                  <button onclick={() => void onRemoveLink(row.remove)} disabled={removingKeys.has(key)} class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50">
                    {removingKeys.has(key) ? '…' : 'remove'}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if linkGroups.advisory.length > 0}
            <div class="text-muted-foreground mono mb-1 text-[10px] uppercase tracking-widest">advisory (other boards)</div>
            <div class="mb-2.5 space-y-1.5">
              {#each linkGroups.advisory as row (edgeKey(row.remove))}
                {@const key = edgeKey(row.remove)}
                <div
                  class="bg-inset border-border mono flex items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]"
                  title={row.badge?.tooltip ?? `${row.relation === 'blocks' ? 'Blocks' : 'Relates to'} ${row.title} on another board — advisory, not enforced`}
                >
                  {#if row.badge}
                    <span class="blk-pill blk-pill-advisory">{row.badge.glyph}</span>
                  {/if}
                  <span class="min-w-0 flex-1 truncate">
                    {row.title}
                    {#if row.relation !== 'blocked-by'}<span class="text-muted-foreground">· {row.relation}</span>{/if}
                  </span>
                  <button onclick={() => void onRemoveLink(row.remove)} disabled={removingKeys.has(key)} class="text-muted-foreground hover:text-coral shrink-0 text-[10px] disabled:opacity-50">
                    {removingKeys.has(key) ? '…' : 'remove'}
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          {#if !hasAnyLink}
            <p class="text-muted-foreground mb-2.5 text-xs">No links on this card.</p>
          {/if}

          {#if linksError}
            <p role="alert" class="text-coral mono mb-2.5 text-[11px]">{linksError}</p>
          {/if}

          <Button size="sm" variant="outline" onclick={openAddBlocker}>Add link</Button>

          {#if addBlockerOpen}
            <div class="bg-inset border-border mt-2.5 space-y-2 rounded-[8px] border p-3 text-xs">
              <!--
                Re-review N3: the dialogue always creates an edge pointing AT this card ("picked
                card → this card") — there is no way, here, to create the reverse. That used to be
                implicit in generic Board/Card/Kind fields sitting directly under a visible "blocks"
                (outgoing) group, which invites exactly the wrong expectation. Said outright instead
                of left to be inferred, per the reviewer's finding — the symmetry argument for NOT
                adding an outgoing-creation path stands (that edge is always reachable from the
                other card's own drawer), so this fixes the wording, not the architecture.
              -->
              <p class="text-muted-foreground mono text-[10.5px]">
                The card you pick below will point <strong>at "{card.title}"</strong> — e.g. picking "blocks" creates
                "picked card blocks this card", never the other way around.
              </p>
              <div>
                <label for="blocker-board" class="text-muted-foreground mono mb-1 block text-[11px] uppercase tracking-widest">Board</label>
                <select
                  id="blocker-board"
                  bind:value={blockerBoardId}
                  onchange={() => void onBlockerBoardChange()}
                  class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none"
                >
                  {#each app.boards as b (b.id)}
                    <option value={b.id}>{b.name}</option>
                  {/each}
                </select>
              </div>

              {#if crossBoardNoticeText}
                <!-- Shown the moment a different board is picked — BEFORE any request, never after. -->
                <p class="mono text-[11px]" style="color:var(--marigold)">⚑ {crossBoardNoticeText}</p>
              {/if}

              <div>
                <label for="blocker-card" class="text-muted-foreground mono mb-1 block text-[11px] uppercase tracking-widest">Card (the one that will act on this one)</label>
                <select
                  id="blocker-card"
                  bind:value={blockerCardId}
                  class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none"
                >
                  <option value="">Pick a card…</option>
                  {#each blockerBoardCards as c (c.id)}
                    <option value={c.id}>{c.title}</option>
                  {/each}
                </select>
              </div>

              <div>
                <label for="blocker-kind" class="text-muted-foreground mono mb-1 block text-[11px] uppercase tracking-widest">Kind</label>
                <select
                  id="blocker-kind"
                  bind:value={blockerKind}
                  class="bg-surface border-border focus:border-marigold w-full rounded-[6px] border px-2 py-1.5 text-xs outline-none"
                >
                  <option value="blocks">blocks this card — this card will not be claimed while it is open</option>
                  <option value="relates">relates to this card — informational only</option>
                </select>
              </div>

              <div class="flex gap-1.5">
                <Button size="sm" onclick={() => void onAddBlocker()} disabled={blockerCardId === '' || addingBlocker}>
                  {addingBlocker ? 'Adding…' : 'Add'}
                </Button>
                <Button size="sm" variant="ghost" onclick={() => (addBlockerOpen = false)}>Cancel</Button>
              </div>

              {#if blockerError}
                <p role="alert" class="text-coral mono text-[11px]">{blockerError}</p>
              {/if}
            </div>
          {/if}
        </section>

        <!--
          Sub-tasks (Step 1b) — children with their state and cost, plus "Add sub-task".
          `children` (script, above) reads `parentCardId` straight off the board's own card list;
          `card.openChildCount`/the count of `children` is the same pair `CardTile`'s counter shows.
        -->
        <section class="sec">
          <div class="sec-h eyebrow">
            sub-tasks
            {#if totalChildren > 0}<span class="ml-auto">{card.openChildCount}/{totalChildren} open</span>{/if}
          </div>
          {#if children.length > 0}
            <div class="mb-2.5 space-y-1.5">
              {#each children as child (child.id)}
                <button
                  onclick={() => app.openCard(child.id)}
                  class="bg-inset border-border mono flex w-full items-center gap-2 rounded-[7px] border px-2.5 py-1.5 text-left text-[11px]"
                >
                  <span class="min-w-0 flex-1 truncate">{child.title}</span>
                  <span class={statePillClass(child.state)} style="padding:1px 7px;font-size:9.5px">{statePillLabel(child.state)}</span>
                  {#if child.costUsd > 0}<span class="text-muted-foreground shrink-0">{fmtUsd(child.costUsd)}</span>{/if}
                </button>
              {/each}
            </div>
          {/if}
          <div class="flex gap-1.5">
            <input
              bind:value={newSubtaskTitle}
              placeholder="New sub-task title…"
              onkeydown={(e) => { if (e.key === 'Enter') void addSubtask(); }}
              class="bg-inset border-border focus:border-marigold flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onclick={() => void addSubtask()} disabled={newSubtaskTitle.trim() === '' || addingSubtask}>
              {addingSubtask ? 'Adding…' : 'Add'}
            </Button>
          </div>
          {#if subtaskError}
            <p role="alert" class="text-coral mono mt-1.5 text-[11px]">{subtaskError}</p>
          {/if}
        </section>

        <!-- activity stream -->
        <section class="sec">
          <div class="sec-h eyebrow">session activity</div>
          <!--
            The timeline opens with provenance, so the first thing read is the frame for everything
            after it: who asked for this card, on what authority, and who holds it now.

            Above the empty-state branch deliberately. A card an agent queued and nobody has picked
            up is precisely where "who asked for this" matters most — that is the shape of an agent
            queueing work that no capability can claim, and the version of this that sat inside the
            `{#else}` would have hidden it on every such card.
          -->
          {#if provenance?.known}
            <p class="mono text-muted-foreground mb-1.5 text-[10.5px]">
              asked by {provenance.queuedByName}{provenance.byAgent ? ' (an agent)' : ''}
              · {grantSummary}
              · {delegateId ? `held by ${delegateName}` : 'held by nobody'}
            </p>
          {/if}
          {#if !cardDetail || cardDetail.activities.length === 0}
            <p class="text-muted-foreground text-xs">No recorded activity yet — this card hasn't been worked.</p>
          {:else}
            <div class="mb-1.5 flex items-center gap-2">
              <button
                onclick={() => (showToolCalls = !showToolCalls)}
                aria-pressed={showToolCalls}
                class="mono border-border hover:bg-accent rounded-[6px] border px-1.5 py-0.5 text-[10px]"
                style="min-height:var(--tap)"
              >{showToolCalls ? 'hide tool calls' : 'show tool calls'}</button>
              <span class="text-muted-foreground mono text-[10px]">
                {activityGroups.length} run{activityGroups.length === 1 ? '' : 's'}
              </span>
            </div>

            <!--
              One `<details>` per run, and per expandable row.

              Native disclosure rather than a click handler on a div: it is keyboard-operable and
              announced as expandable for free, and the previous stream had a `▸` glyph that LOOKED
              expandable and was decorative — a UI that promises a detail it does not have.
            -->
            <div class="stream flex flex-col gap-1.5">
              {#each activityGroups as g, gi (g.runId)}
                {@const view = visibleActivities(g.activities, isNarrative, showToolCalls)}
                {@const rows = view.rows}
                <details open={defaultOpen(activityGroups, gi)} class="border-border rounded-[7px] border">
                  <summary
                    class="mono flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[11px]"
                    style="min-height:var(--tap)"
                  >
                    <!--
                      The run id when the stage is unknown. The attempts fetch can fail or lag,
                      and five groups all reading "unassigned run" are indistinguishable — which
                      is the flat list this change replaces, in miniature.
                    -->
                    <span style="color:var(--marigold)">{g.stageKey ?? `run ${g.runId.slice(-6)}`}</span>
                    {#if g.agentId}
                      <span class="text-muted-foreground truncate" title={g.agentId}>{displayAgent(g.agentId, app.agents)}</span>
                    {/if}
                    {#if g.outcome}
                      <span style="color:{g.outcome === 'completed' ? 'var(--live)' : 'var(--coral)'}">{g.outcome}</span>
                    {/if}
                    <!--
                      "attempt 2" rather than two things that look like two stages. A retry at one
                      stage is its own run with its own story, and the fact that an earlier one failed
                      is the most useful thing on the card — so it is named, not merged away.
                    -->
                    {#if (stageByRun.get(g.runId)?.attemptOfStage ?? 1) > 1}
                      <span class="text-muted-foreground text-[10px]">attempt {stageByRun.get(g.runId)!.attemptOfStage}</span>
                    {/if}
                    <span class="text-muted-foreground ml-auto whitespace-nowrap text-[10px]">
                      {g.counts.total} event{g.counts.total === 1 ? '' : 's'}{g.counts.error > 0 ? ` · ${g.counts.error} error` : ''}
                    </span>
                  </summary>

                  <div class="flex flex-col gap-0.5 px-1.5 pb-1.5">
                    {#if view.shownBecauseNoNarrative}
                      <!--
                        Said once, quietly, rather than hiding the run: the reader's preference is
                        narrative-only, and this run has none, so what follows is its tool calls.
                        The alternative — what this replaces — was an empty panel under a heading
                        reading "67 events".
                      -->
                      <p class="text-muted-foreground px-1.5 py-1 text-[11px]">
                        This run said nothing in prose; its tool calls are below.
                      </p>
                    {:else if rows.length === 0}
                      <p class="text-muted-foreground px-1.5 py-1 text-[11px]">No activity recorded for this run.</p>
                    {/if}
                    {#each rows as a (a.seq)}
                      {@const m = activityMarker(a.type)}
                      {@const detail = a.parameter !== null || a.result !== null}
                      {#if detail}
                        <details class="act {m.cssClass} rounded-[6px]">
                          <summary class="grid cursor-pointer px-1.5 py-1.5 text-[12.5px] items-start" style="grid-template-columns:18px 1fr auto;gap:9px;min-height:var(--tap)">
                            <span class="act-icon text-[12px] text-center pt-px">{m.glyph}</span>
                            <div class="act-body min-w-0" style="overflow-wrap:anywhere">
                              <span class="act-k font-mono text-[9.5px] uppercase tracking-wider mr-1.5" style="color:var(--muted)">{a.type}</span>
                              {#if a.action}<span class="font-mono text-[11px]" style="color:var(--marigold)">{a.action}</span>{/if}
                              {#if a.body}<div class="mt-0.5 text-xs leading-relaxed {a.type === 'error' || a.type === 'elicitation' ? 'text-coral' : 'text-foreground/90'}">{a.body}</div>{/if}
                            </div>
                            <span class="act-ts text-muted-foreground font-mono text-[10px] whitespace-nowrap pt-px">{fmtTime(a.ts)}</span>
                          </summary>
                          <!--
                            `result` was populated on 153 of this card's 366 activities and rendered
                            nowhere at all, and `parameter` was truncated at 140 characters with no
                            way to see the rest. Both were already on the wire.
                          -->
                          <div class="space-y-1 px-2 pb-2 pl-[27px]">
                            {#if a.parameter !== null}
                              <div>
                                <div class="mono text-[9.5px] uppercase tracking-wider" style="color:var(--muted)">parameter</div>
                                <pre class="bg-inset mt-0.5 overflow-x-auto rounded-[5px] px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap" style="overflow-wrap:anywhere">{JSON.stringify(a.parameter, null, 2)}</pre>
                              </div>
                            {/if}
                            {#if a.result !== null}
                              <div>
                                <div class="mono text-[9.5px] uppercase tracking-wider" style="color:var(--muted)">result</div>
                                <pre class="bg-inset mt-0.5 overflow-x-auto rounded-[5px] px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap" style="overflow-wrap:anywhere">{typeof a.result === 'string' ? a.result : JSON.stringify(a.result, null, 2)}</pre>
                              </div>
                            {/if}
                          </div>
                        </details>
                      {:else}
                        <div class="act {m.cssClass} grid rounded-[6px] px-1.5 py-1.5 text-[12.5px] items-start" style="grid-template-columns:18px 1fr auto;gap:9px">
                          <span class="act-icon text-[12px] text-center pt-px">{m.glyph}</span>
                          <div class="act-body min-w-0" style="overflow-wrap:anywhere">
                            <span class="act-k font-mono text-[9.5px] uppercase tracking-wider mr-1.5" style="color:var(--muted)">{a.type}</span>
                            {#if a.action}<span class="font-mono text-[11px]" style="color:var(--marigold)">{a.action}</span>{/if}
                            {#if a.body}<div class="mt-0.5 text-xs leading-relaxed {a.type === 'error' || a.type === 'elicitation' ? 'text-coral' : 'text-foreground/90'}">{a.body}</div>{/if}
                          </div>
                          <span class="act-ts text-muted-foreground font-mono text-[10px] whitespace-nowrap pt-px">{fmtTime(a.ts)}</span>
                        </div>
                      {/if}
                    {/each}

                    <!--
                      How this run ended, and what it attached.
                      ──────────────────────────────────────────
                      The activities above say what the agent DID; this says what it concluded, and
                      it is the half that had nowhere to live. The handoff was one column on the card,
                      overwritten by the next stage; a failure's reason went to a notification and the
                      event stream. Both are now kept on the run itself.

                      Nothing is rendered for a run that ended with neither — a legacy card, or a
                      completed run that said nothing — because an empty "Handoff" heading is worse
                      than silence.
                    -->
                    {#if stageByRun.get(g.runId)}
                      {@const e = stageByRun.get(g.runId)!}
                      {#if e.failureReason}
                        <div class="stage-foot stage-foot-failed">
                          <div class="stage-foot-h">failed</div>
                          <div class="text-xs leading-relaxed">{e.failureReason}</div>
                        </div>
                      {:else if formatHandoff(e.handoff).length > 0}
                        <div class="stage-foot">
                          <div class="stage-foot-h">handed on</div>
                          {#each formatHandoff(e.handoff) as f (f.label ?? f.value)}
                            <div class="text-xs leading-relaxed">
                              {#if f.label}<span class="mono text-muted-foreground">{f.label}:</span>{/if}
                              {f.value}
                            </div>
                          {/each}
                        </div>
                      {/if}
                      {#if e.references.length > 0}
                        <div class="stage-foot">
                          <div class="stage-foot-h">attached here</div>
                          <div class="flex flex-wrap gap-1">
                            {#each e.references as r (r.id)}
                              <a class="refchip hover:border-marigold/50" href={r.url} target="_blank" rel="noreferrer noopener">
                                {r.title || r.url}
                              </a>
                            {/each}
                          </div>
                        </div>
                      {/if}
                    {/if}
                  </div>
                </details>
              {/each}
            </div>
            {#if card.state === 'working'}
              <div class="streamcap mt-2 flex items-center gap-2 font-mono text-[10.5px]" style="color:var(--muted)">
                <span class="live-dot"></span> streaming live…
              </div>
            {/if}
          {/if}
        </section>

        <!--
          Approval history.

          `gates.decided_by` and `gates.comment` were written on every resolution and appeared in
          no read shape at all, so who approved a card — and the feedback they gave with it — was
          recorded and unreadable. An approval nobody can attribute is not much of an approval.
        -->
        {#if decidedGates.length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">decisions</div>
            <div class="space-y-1.5">
              {#each decidedGates as g (g.id)}
                <div class="bg-inset border-border rounded-[8px] border px-3 py-2 text-[11px]">
                  <div class="flex items-center gap-1.5">
                    <span class="mono" style="color:{g.decision === 'approve' ? 'var(--live)' : 'var(--coral)'}">{g.decision ?? g.status}</span>
                    <span class="text-muted-foreground">at</span>
                    <span class="mono">{g.stageKey}</span>
                    {#if g.decidedBy}
                      <span class="text-muted-foreground">by</span>
                      <!-- A gate decided through AgentPod records a `prn_…` whose directory is in
                           another product, so it shortens rather than resolves. -->
                      <span class="mono truncate" title={g.decidedBy}>{displayPrincipal(g.decidedBy, app.members)}</span>
                    {/if}
                  </div>
                  {#if g.comment}
                    <p class="text-muted-foreground mt-1 leading-relaxed">{g.comment}</p>
                  {/if}
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- handoff from prior stage -->
        {#if cardDetail?.handoff && Object.keys(cardDetail.handoff).length > 0}
          <section class="sec">
            <div class="sec-h eyebrow">handoff from prior stage</div>
            <!--
              `overflow-wrap:anywhere`, not `break-word`, and not nothing.

              A handoff value is whatever the agent put there, and an agent that reports
              `{"artifact_commit_readback":"passed","github_commit_public":"verified"}` has written a
              single token with no space in it. `break-word` will not break inside one; the line ran
              324px past the right edge of a phone. `anywhere` breaks it, and also lets the row
              shrink below its longest word, which is what stops the drawer scrolling sideways.
            -->
            <div class="bg-inset border-border mono min-w-0 space-y-1 rounded-[8px] border p-3 text-[11px]" style="overflow-wrap:anywhere">
              {#each Object.entries(cardDetail.handoff) as [k, v] (k)}
                <div class="min-w-0"><span class="text-muted-foreground">{k}:</span> {typeof v === 'string' ? v : JSON.stringify(v)}</div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- cost block -->
        {#if card.costUsd > 0 || cardEstimate?.estimatedUsd}
          <section class="sec">
            <div class="sec-h eyebrow">cost</div>
            <div class="costblock flex items-baseline gap-2 font-mono">
              <span class="text-[21px] font-semibold" style="color:var(--text)">{fmtUsd(card.costUsd)}</span>
              {#if cardEstimate?.estimatedUsd !== null && cardEstimate?.estimatedUsd !== undefined}
                <span class="text-[11.5px]" style="color:var(--muted)">
                  / {fmtUsd(cardEstimate.estimatedUsd)} estimate
                  {#if card.overBudget}<span style="color:var(--coral)"> · over budget</span>{/if}
                  {#if cardEstimate.sampleSize > 0}<span title="{cardEstimate.sampleSize} similar run{cardEstimate.sampleSize === 1 ? '' : 's'}"> · {cardEstimate.sampleSize}× sample</span>{/if}
                </span>
              {/if}
            </div>
            <div class="costmeter mt-2 h-1.5 overflow-hidden rounded-full bg-inset {card.overBudget ? 'costmeter-over' : ''}">
              <div class="h-full rounded-full transition-all duration-1000" style="width:{costPct}%;background:{card.overBudget ? 'var(--coral)' : 'var(--live)'}"></div>
            </div>
          </section>
        {/if}

        <!-- attempts (if > 1) -->
        {#if drawerAttempts.length > 1}
          <section class="sec">
            <div class="sec-h eyebrow">attempts · {drawerAttempts.length}</div>
            <div class="space-y-1.5">
              {#each drawerAttempts as a, i (a.runId)}
                <div class="bg-inset border-border mono flex items-center justify-between gap-2 rounded-[7px] border px-2.5 py-1.5 text-[11px]">
                  <span class="text-muted-foreground truncate" title={a.agentId}>{i + 1} · {displayAgent(a.agentId, app.agents)}{a.profileKey ? ` · ${a.profileKey}` : a.model ? ` · ${a.model}` : ''}</span>
                  <span class="shrink-0">{fmtUsd(a.costUsd)}{a.outcome ? ` · ${a.outcome}` : ''}</span>
                </div>
              {/each}
            </div>
          </section>
        {/if}

        <!-- references -->
        <section class="sec">
          <div class="sec-h eyebrow">references</div>
          {#if refs.length > 0}
            <div class="mb-2.5 flex flex-wrap gap-1.5">
              {#each refs as ref (ref.id)}
                {@const href = safeHref(ref.url)}
                {@const inner = `${refLabel(ref)}${subStateLabel(ref) ? ` · ${subStateLabel(ref)}` : ''}`}
                {#if href}
                  <a {href} target="_blank" rel="noreferrer" class="border-border hover:border-marigold/50 mono inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px]"><span style="color:var(--marigold)">↗</span>{inner}</a>
                {:else}
                  <span class="border-border mono inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[10px]">{inner}</span>
                {/if}
              {/each}
            </div>
          {/if}
          <div class="flex gap-1.5">
            <input
              bind:value={newRefUrl}
              placeholder="https://… attach a link"
              onkeydown={(e) => { if (e.key === 'Enter') addRef(); }}
              class="bg-inset border-border focus:border-marigold flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
            />
            <Button size="sm" variant="outline" onclick={addRef} disabled={newRefUrl.trim() === ''}>Add</Button>
          </div>
        </section>

        <!-- archive / un-archive / delete -->
        <div class="border-border/60 flex gap-3 border-t pt-4">
          {#if card.archivedAt}
            <button onclick={() => void onUnarchiveCard()} disabled={archiving} class="text-muted-foreground hover:text-marigold text-xs disabled:opacity-50">
              {archiving ? 'Un-archiving…' : 'Archived — un-archive'}
            </button>
          {:else}
            <button onclick={() => void onArchiveCard()} disabled={archiving} class="text-muted-foreground hover:text-marigold text-xs disabled:opacity-50">
              {archiving ? 'Archiving…' : 'Archive card'}
            </button>
          {/if}
          <button onclick={onDeleteCard} class="text-muted-foreground hover:text-coral text-xs">Delete card</button>
        </div>
      </div>
    </div>
  </div>
{/if}
