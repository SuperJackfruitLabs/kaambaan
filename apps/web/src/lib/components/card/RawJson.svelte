<!--
  "View raw JSON": the value exactly as stored, for debugging, behind a small toggle and with a Copy
  button. The readable view above it is the default; this is the escape hatch.
-->
<script lang="ts">
  import { rawJson } from './spec-details';

  let { value }: { value: unknown } = $props();

  let open = $state(false);
  let copied = $state(false);
  const text = $derived(rawJson(value));

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
</script>

<div class="raw mt-2">
  <div class="flex items-center gap-3">
    <button type="button" class="raw-btn text-[10.5px]" aria-expanded={open} onclick={() => (open = !open)}>
      {open ? 'Hide raw JSON' : 'View raw JSON'}
    </button>
    {#if open}
      <button type="button" class="raw-btn text-[10.5px]" onclick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    {/if}
  </div>
  {#if open}
    <pre class="raw-pre bg-inset border-border mt-1 rounded-[5px] border px-2 py-1.5 font-mono text-[11px]">{text}</pre>
  {/if}
</div>

<style>
  .raw-btn {
    color: var(--muted);
    min-height: 24px;
  }
  .raw-btn:hover {
    color: var(--marigold);
  }
  /* Wrapped, not scrolled: the drawer must not move sideways on a phone. */
  .raw-pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 24rem;
    overflow-y: auto;
  }
</style>
