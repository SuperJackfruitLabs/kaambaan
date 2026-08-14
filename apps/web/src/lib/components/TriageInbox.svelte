<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { agentColor, initialOf } from '$lib/components/agentColor';

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  function reasonBadge(cardId: string, overBudget: boolean, state: string): string {
    if (app.gateForCard(cardId)) return 'awaiting review';
    if (app.elicitationForCard(cardId)) return 'awaiting your answer';
    if (overBudget) return 'over budget';
    if (state === 'failed') return 'failed';
    return '';
  }

  function priorityLabel(p: number): string {
    return p > 0 ? `P${p}` : 'P—';
  }

  function priorityClass(p: number): string {
    if (p === 1) return 'pri-chip pri-chip-1';
    if (p === 2) return 'pri-chip pri-chip-2';
    return 'pri-chip pri-chip-3';
  }

  const needsYou = $derived(app.needsYou());
  const unreadNotifs = $derived(app.notifications.filter((n) => !n.read));
  const isEmpty = $derived(needsYou.length === 0 && unreadNotifs.length === 0);
</script>

<div class="triage-pad scroll overflow-y-auto h-full">
  <!-- Header -->
  <div class="triage-header">
    <div class="eyebrow mb-1">Triage</div>
    <h1 class="triage-title">
      Needs You
      {#if needsYou.length > 0}
        <span class="triage-count">{needsYou.length}</span>
      {/if}
    </h1>
    <p class="triage-sub">Everything that needs you.</p>
  </div>

  {#if isEmpty}
    <!-- Empty state -->
    <div class="triage-empty-state">
      <span class="triage-empty-icon">✓</span>
      <span class="triage-empty-text">All clear — nothing needs you.</span>
    </div>
  {:else}
    <!-- Needs You queue -->
    {#if needsYou.length > 0}
      <div class="triage-section">
        <div class="sec-h">
          <span>Action required</span>
          <span class="triage-sep"></span>
        </div>
        <div class="triage-list">
          {#each needsYou as card (card.id)}
            {@const reason = reasonBadge(card.id, card.overBudget, card.state)}
            <div class="triage-item tile-gate">
              <div class="triage-item-top">
                <!-- Reason badge -->
                <span class="triage-badge">{reason}</span>
                <!-- Priority -->
                <span class={priorityClass(card.priority)}>{priorityLabel(card.priority)}</span>
                <!-- Title -->
                <span class="triage-item-title">{card.title}</span>
                <!-- Owner avatar -->
                <span
                  class="triage-avatar"
                  style="background:{agentColor(card.ownerUserId)}"
                  title={card.ownerUserId}
                >
                  {initialOf(card.ownerUserId)}
                </span>
                <!-- Stage -->
                <span class="triage-stage">{card.currentStageKey}</span>
              </div>
              <div class="triage-item-foot">
                <button
                  class="triage-review-btn"
                  onclick={() => app.openCard(card.id)}
                >
                  Review →
                </button>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Activity section -->
    {#if unreadNotifs.length > 0}
      <div class="triage-section">
        <div class="sec-h">
          <span>Activity</span>
          <span class="triage-sep"></span>
        </div>
        <div class="triage-activity-list">
          {#each unreadNotifs as notif (notif.seq)}
            <div class="triage-activity-item">
              <span class="triage-activity-dot"></span>
              <span class="triage-activity-body">{notif.body}</span>
              <span class="triage-activity-time">{relativeTime(notif.createdAt)}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
