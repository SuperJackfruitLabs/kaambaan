<script lang="ts">
  import { app } from '$lib/stores/app.svelte';
  import { goto } from '$app/navigation';
  import { tick } from 'svelte';

  // ---- state ----
  let query = $state('');
  let selectedIdx = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  // ---- build the item index ----
  interface CmdItem {
    grp: string;
    icon: string;
    label: string;
    sub: string;
    act: () => void;
  }

  function buildIndex(): CmdItem[] {
    const items: CmdItem[] = [];

    // Cards
    const cards = app.board?.cards ?? [];
    for (const card of cards) {
      const shortId = card.id.slice(0, 8);
      items.push({
        grp: 'Cards',
        icon: '▦',
        label: card.title,
        sub: `#${shortId}`,
        act: () => {
          // A card is an address. Navigating rather than setting state means the palette produces
          // a link the reader could have pasted.
          void goto(`/b/${app.boardId}/c/${card.id}`);
          close();
        },
      });
    }

    // Agents
    for (const agent of app.agents) {
      items.push({
        grp: 'Agents',
        icon: '◉',
        label: agent.name,
        sub: agent.capabilities.length > 0 ? agent.capabilities.join(', ') : 'no capabilities',
        act: () => {
          // Selecting an agent used to close the palette and do nothing at all. Agents live at an
          // address now, so this navigates rather than signalling a component to open a modal.
          void goto('/workspace/agents');
          close();
        },
      });
    }

    // Static actions
    items.push(
      {
        grp: 'Actions',
        icon: '+',
        label: 'Dispatch a card',
        sub: '',
        act: () => {
          app.requestCompose();
          close();
        },
      },
      {
        grp: 'Actions',
        icon: '⊞',
        label: 'Operate',
        sub: 'what needs you, what is running, what it cost',
        act: () => {
          void goto(`/b/${app.boardId}/operate`);
          close();
        },
      },
      {
        grp: 'Actions',
        icon: '◴',
        label: 'Spend detail',
        sub: 'by model, by card, and the board log',
        act: () => {
          void goto(`/b/${app.boardId}/operate/telemetry`);
          close();
        },
      },
    );

    return items;
  }

  // ---- filtered results ----
  const filtered = $derived.by(() => {
    const q = query.toLowerCase().trim();
    const all = buildIndex();
    if (!q) return all;
    return all.filter(
      (x) =>
        x.label.toLowerCase().includes(q) ||
        x.grp.toLowerCase().includes(q) ||
        x.sub.toLowerCase().includes(q),
    );
  });

  // ---- grouped view ----
  const grouped = $derived.by(() => {
    const map = new Map<string, Array<CmdItem & { flatIdx: number }>>();
    let flatIdx = 0;
    for (const item of filtered) {
      if (!map.has(item.grp)) map.set(item.grp, []);
      map.get(item.grp)!.push({ ...item, flatIdx: flatIdx++ });
    }
    return map;
  });

  // ---- close + open helpers ----
  function close(): void {
    app.cmdkOpen = false;
    query = '';
    selectedIdx = 0;
  }

  function run(idx: number): void {
    filtered[idx]?.act();
  }

  // ---- keyboard ----
  function onKeydown(e: KeyboardEvent): void {
    // Cmd-K / Ctrl-K toggles
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      app.toggleCmdk();
      return;
    }

    if (!app.cmdkOpen) return;

    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIdx = (selectedIdx + 1) % Math.max(1, filtered.length);
      scrollSelected();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIdx = (selectedIdx - 1 + Math.max(1, filtered.length)) % Math.max(1, filtered.length);
      scrollSelected();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      run(selectedIdx);
      return;
    }
  }

  function scrollSelected(): void {
    void tick().then(() => {
      document.querySelector<HTMLElement>('.cmdk-it.sel')?.scrollIntoView({ block: 'nearest' });
    });
  }

  // ---- focus on open ----
  $effect(() => {
    if (app.cmdkOpen) {
      query = '';
      selectedIdx = 0;
      void tick().then(() => inputEl?.focus());
    }
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#if app.cmdkOpen}
  <!-- Backdrop -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
    style="background:rgba(8,9,13,.55)"
    role="dialog"
    aria-modal="true"
    aria-label="Command palette"
  >
    <button
      class="absolute inset-0"
      onclick={close}
      tabindex="-1"
      aria-label="Close command palette"
    ></button>

    <!-- Palette box -->
    <div class="cmdk-box relative">
      <!-- Input row -->
      <div class="cmdk-in">
        <svg class="size-4 shrink-0" style="color:var(--muted)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
        </svg>
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder="Jump to a card, agent, or action…"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="cmdk-esc">esc</span>
      </div>

      <!-- Results list -->
      <div class="cmdk-list">
        {#if filtered.length === 0}
          <div class="cmdk-empty">No matches</div>
        {:else}
          {#each grouped as [grp, items] (grp)}
            <div class="cmdk-grp">{grp}</div>
            {#each items as item (item.flatIdx)}
              <button
                class="cmdk-it {item.flatIdx === selectedIdx ? 'sel' : ''}"
                onmouseenter={() => (selectedIdx = item.flatIdx)}
                onclick={() => run(item.flatIdx)}
              >
                <span class="cmdk-ic">{item.icon}</span>
                <span class="cmdk-label">{item.label}</span>
                {#if item.sub}
                  <span class="cmdk-sub">{item.sub}</span>
                {/if}
              </button>
            {/each}
          {/each}
        {/if}
      </div>

      <!-- Footer hints -->
      <div class="cmdk-foot">
        <span>↑↓ navigate</span>
        <span>↵ select</span>
        <span>esc close</span>
      </div>
    </div>
  </div>
{/if}
