<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import AgentsTab from '$lib/components/workspace/AgentsTab.svelte';
  import CapabilitiesTab from '$lib/components/workspace/CapabilitiesTab.svelte';
  import LabelManager from '$lib/components/workspace/LabelManager.svelte';
  import PeopleTab from '$lib/components/workspace/PeopleTab.svelte';
  import ConnectionsTab from '$lib/components/workspace/ConnectionsTab.svelte';
  import NeedsYouTab from '$lib/components/workspace/NeedsYouTab.svelte';

  const tab = $derived(page.params.tab);

  // An unknown tab redirects rather than rendering nothing — a mistyped URL should land somewhere,
  // not on a blank page that looks like a failure.
  $effect(() => {
    if (tab && !['needs-you', 'agents', 'capabilities', 'labels', 'people', 'connections'].includes(tab)) {
      void goto('/workspace/agents', { replaceState: true });
    }
  });
</script>

{#if tab === 'needs-you'}
  <NeedsYouTab />
{:else if tab === 'capabilities'}
  <CapabilitiesTab />
{:else if tab === 'labels'}
  <LabelManager />
{:else if tab === 'people'}
  <PeopleTab />
{:else if tab === 'connections'}
  <ConnectionsTab />
{:else}
  <AgentsTab />
{/if}
