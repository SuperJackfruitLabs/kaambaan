<script lang="ts">
  /**
   * Operate — what needs me, what is running, what it cost, and what happened.
   *
   * This mode is why the header stopped overflowing. It absorbs four surfaces that each had their
   * own place in the chrome: Triage (a rail destination), Telemetry (another), the notification
   * bell, and the spend pill. The row was not rearranged; it was given fewer reasons to exist.
   *
   * Scoped to one board, deliberately (spec §3): the Durable Object is per board, so a
   * workspace-wide deck would need a fan-out read across every board's DO. Work needing attention
   * on another board is found when you switch to it.
   */
  import NeedsYou from './NeedsYou.svelte';
  import Running from './Running.svelte';
  import Spend from './Spend.svelte';
  import Activity from './Activity.svelte';
</script>

<div class="mx-auto grid max-w-3xl gap-3 p-3">
  <NeedsYou />
  <Running />
  <Spend />
  <Activity />
</div>
