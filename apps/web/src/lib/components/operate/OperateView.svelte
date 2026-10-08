<script lang="ts">
  /**
   * Operate — what needs me, what is running, what it cost, and what happened.
   *
   * This mode is why the header stopped overflowing. It absorbs four surfaces that each had their
   * own place in the chrome: Triage (a rail destination), Telemetry (another), the notification
   * bell, and the spend pill. The row was not rearranged; it was given fewer reasons to exist.
   *
   * Scoped to one board (spec §3): the Durable Object is per board. What needs a person on every
   * board is one list at /workspace/needs-you, read through the one fan-out built for it
   * (`GET /v1/stale?attention=1`); the panel here links there.
   */
  import NeedsYou from './NeedsYou.svelte';
  import Running from './Running.svelte';
  import Spend from './Spend.svelte';
  import Activity from './Activity.svelte';
</script>

<!-- One column up to 1200px; above it two — what needs a person on the left, what it cost and
     what happened on the right. A single 742px column used 40% of a 1920px screen and stacked
     four panels a reader had to scroll past to reach Activity (responsive audit, 2026-10-07). -->
<div class="touch-form mx-auto grid max-w-3xl items-start gap-3 p-3 min-[1200px]:max-w-[1400px] min-[1200px]:grid-cols-2 min-[1200px]:p-4">
  <div class="grid min-w-0 gap-3">
    <NeedsYou />
    <Running />
  </div>
  <div class="grid min-w-0 gap-3">
    <Spend />
    <Activity />
  </div>
</div>
