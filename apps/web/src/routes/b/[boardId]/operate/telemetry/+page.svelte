<script lang="ts">
  /**
   * Spend, in detail — by model, by card, over a window, plus the board's own event log.
   *
   * A sub-view rather than more sections on Operate: the summary answers "are we fine", and these
   * answer "where did it go", which is a question you go looking for rather than one that should
   * be on screen every time.
   */
  import Telemetry from '$lib/components/Telemetry.svelte';
  import { app } from '$lib/stores/app.svelte';
</script>

<div class="p-3">
  <a href="/b/{app.boardId}/operate" class="text-muted-foreground hover:text-foreground mono mb-2 inline-flex items-center gap-1 text-[11px]" style="min-height:var(--tap)">
    <span aria-hidden="true">←</span> Operate
  </a>
  <Telemetry />
</div>
