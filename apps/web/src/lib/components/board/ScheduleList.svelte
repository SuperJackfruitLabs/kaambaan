<script lang="ts">
  /**
   * Board settings' schedules section — the list, and the add form, kept separable per the plan's
   * code-organization note (`BoardSettings.svelte` already carries the pipeline editor and the
   * GitHub/profile sections; this stays its own file rather than growing that one further).
   *
   * `getSchedules`/`createSchedule`/`updateSchedule`/`deleteSchedule` are Task 10's client for the
   * `/v1/boards/:id/schedules[/:scheduleId]` routes over Task 8/9's rule grammar and DO CRUD —
   * neither had a route, and this is the first UI that can reach either.
   */
  import { Button } from '$lib/components/ui/button';
  import { getSchedules, createSchedule, updateSchedule, deleteSchedule, type Schedule, type Stage } from '$lib/api';
  import { formatFireTime } from './schedule-format';

  let { boardId, stages }: { boardId: string; stages: Stage[] } = $props();

  let schedules = $state<Schedule[]>([]);
  let loaded = $state(false);
  let busy = $state('');
  let formError = $state<string | null>(null);

  let title = $state('');
  let rule = $state('');
  let timezone = $state('');
  let stageKey = $state('');
  let priority = $state('');
  let overlap = $state<'skip' | 'allow'>('skip');

  async function load(): Promise<void> {
    schedules = await getSchedules(boardId);
    loaded = true;
  }

  $effect(() => {
    if (!loaded) void load();
  });

  async function add(): Promise<void> {
    formError = null;
    const t = title.trim();
    const r = rule.trim();
    const tz = timezone.trim();
    if (t === '' || r === '' || tz === '') return;
    busy = 'add';
    try {
      const res = await createSchedule(boardId, {
        title: t,
        rule: r,
        timezone: tz,
        overlap,
        ...(stageKey.trim() !== '' ? { stageKey: stageKey.trim() } : {}),
        ...(priority.trim() !== '' ? { priority: Number(priority) } : {}),
      });
      if (!res.ok) {
        // The parser's own message — "the shortest interval is 5 minutes", "not a time zone this
        // runtime knows" — is the only sentence that tells the author what to type instead.
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        formError = body?.error?.message ?? `Could not add the schedule (${res.status}).`;
        return;
      }
      title = '';
      rule = '';
      timezone = '';
      stageKey = '';
      priority = '';
      overlap = 'skip';
      await load();
    } finally {
      busy = '';
    }
  }

  async function toggle(s: Schedule): Promise<void> {
    busy = s.id;
    try {
      await updateSchedule(boardId, s.id, { enabled: !s.enabled });
      await load();
    } finally {
      busy = '';
    }
  }

  async function remove(s: Schedule): Promise<void> {
    busy = s.id;
    try {
      await deleteSchedule(boardId, s.id);
      await load();
    } finally {
      busy = '';
    }
  }
</script>

<section>
  <div class="eyebrow mb-2">schedules</div>
  <p class="text-muted-foreground mb-3 text-xs leading-relaxed">
    A recurring card, on a cadence you set. Accepted forms:
    <span class="mono">every &lt;n&gt; minutes|hours|days</span>,
    <span class="mono">daily at HH:MM</span>,
    <span class="mono">weekly on &lt;mon-sun&gt; at HH:MM</span>,
    <span class="mono">monthly on &lt;1-28&gt; at HH:MM</span>.
    Runs are checked every five minutes, so a schedule may fire up to five minutes after its stated time.
  </p>

  {#if schedules.length > 0}
    <div class="mb-3 space-y-1.5">
      {#each schedules as s (s.id)}
        <div class="bg-inset border-border rounded-[8px] border px-2.5 py-2 text-xs">
          <div class="flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-1.5">
              <span class="truncate">{s.title}</span>
              {#if !s.enabled}<span class="mono text-muted-foreground shrink-0 text-[10px]">paused</span>{/if}
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                onclick={() => toggle(s)}
                disabled={busy === s.id}
                class="mono text-[10px] disabled:opacity-40"
                style="color:var(--marigold)"
              >
                {s.enabled ? 'pause' : 'resume'}
              </button>
              <button
                onclick={() => remove(s)}
                disabled={busy === s.id}
                aria-label="Remove schedule {s.title}"
                class="text-muted-foreground hover:text-coral disabled:opacity-40"
              >
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          </div>
          <div class="text-muted-foreground mono mt-1 text-[10px]">
            {s.rule} · {s.timezone} · overlap {s.overlap}{#if s.stageKey} · into {s.stageKey}{/if}
          </div>
          <div class="text-muted-foreground mono mt-0.5 text-[10px]">
            next {formatFireTime(s.nextFireAt, s.timezone)} · last {formatFireTime(s.lastFiredAt, s.timezone)}
          </div>
          <!--
            A skip means the previous instance was still open when the next fire came due — the
            signal this schedule is fighting an open card. Invisible if not shown, so it is shown
            only when it has happened (zero is the ordinary state and would just be noise).
          -->
          {#if s.skipCount > 0}
            <div class="mono mt-0.5 text-[10px]" style="color:var(--coral)">
              skipped {s.skipCount} time{s.skipCount === 1 ? '' : 's'} — the previous card was still open when it came due
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  <div class="space-y-1.5">
    <div class="flex flex-wrap gap-1.5">
      <input
        bind:value={title}
        placeholder="title"
        aria-label="Schedule title"
        class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
      />
      <input
        bind:value={rule}
        placeholder="daily at 09:00"
        aria-label="Recurrence rule"
        class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
      />
      <input
        bind:value={timezone}
        placeholder="timezone — e.g. UTC, Asia/Kolkata"
        aria-label="Timezone"
        class="bg-inset border-border focus:border-marigold mono min-w-0 flex-1 rounded-[6px] border px-2.5 py-1.5 text-xs outline-none"
      />
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <select bind:value={stageKey} aria-label="Stage the schedule creates cards in" class="bg-surface border-border mono rounded-[5px] border px-1.5 py-1 text-[10px]">
        <option value="">default (first) stage</option>
        {#each stages as st (st.key)}<option value={st.key}>{st.name}</option>{/each}
      </select>
      <input
        bind:value={priority}
        type="number"
        placeholder="priority"
        aria-label="Priority"
        class="bg-surface border-border mono w-20 rounded-[5px] border px-1.5 py-1 text-[10px]"
      />
      <select bind:value={overlap} aria-label="What to do when the previous card is still open" class="bg-surface border-border mono rounded-[5px] border px-1.5 py-1 text-[10px]">
        <option value="skip">skip while previous is open</option>
        <option value="allow">allow overlap</option>
      </select>
      <Button size="sm" variant="outline" onclick={add} disabled={busy === 'add' || title.trim() === '' || rule.trim() === '' || timezone.trim() === ''}>
        {busy === 'add' ? 'Adding…' : 'Add'}
      </Button>
    </div>
    {#if formError}<p class="text-coral text-xs leading-relaxed">{formError}</p>{/if}
  </div>
</section>
