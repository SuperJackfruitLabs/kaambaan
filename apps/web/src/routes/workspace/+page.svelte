<script lang="ts">
  // Bare /workspace has no tab to show; agents is the one people come here for.
  import { goto } from '$app/navigation';
  $effect(() => void goto('/workspace/agents', { replaceState: true }));
</script>
