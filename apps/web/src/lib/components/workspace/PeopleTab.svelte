<script lang="ts">
  /**
   * Membership, which is the whole human authorization model and was, until recently, one row
   * written once and read by nothing.
   */
  import { getMembers, addMember, setMemberRole, removeMember, type Member, type Role } from '$lib/api';
  import { Button } from '$lib/components/ui/button';

  let members = $state<Member[]>([]);
  let email = $state('');
  let role = $state<Role>('member');
  let error = $state<string | null>(null);
  let busy = $state(false);

  const HELP: Record<Role, string> = {
    viewer: 'reads the board',
    member: 'works the board — cards, gates, questions',
    admin: 'also manages boards and agents',
    owner: 'also manages people and the fleet link',
  };

  async function refresh(): Promise<void> {
    members = await getMembers();
  }
  $effect(() => { void refresh(); });

  async function invite(): Promise<void> {
    const addr = email.trim();
    if (addr === '') return;
    busy = true;
    error = null;
    try {
      const res = await addMember(addr, role);
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        error = body?.error ?? `Inviting failed (${res.status})`;
        return;
      }
      email = '';
      await refresh();
    } finally {
      busy = false;
    }
  }

  async function change(m: Member, next: Role): Promise<void> {
    error = null;
    const res = await setMemberRole(m.userId, next);
    if (!res.ok) {
      // Includes the refusal to leave a workspace with no owner — the one an operator most needs
      // to read rather than guess at.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Changing that role failed (${res.status})`;
    }
    await refresh();
  }

  async function remove(m: Member): Promise<void> {
    if (!confirm(`Remove ${m.email} from this workspace? They lose access on their next request.`)) return;
    error = null;
    const res = await removeMember(m.userId);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      error = body?.error ?? `Removing them failed (${res.status})`;
    }
    await refresh();
  }
</script>

<div class="space-y-2">
  {#each members as m (m.userId)}
    <div class="bg-surface border-border flex items-center gap-2 rounded-[10px] border px-3 py-2.5">
      <span class="min-w-0 flex-1 truncate text-sm" title={m.email}>{m.name ?? m.email}</span>
      <select
        value={m.role}
        onchange={(e) => void change(m, e.currentTarget.value as Role)}
        aria-label="Role for {m.email}"
        title={HELP[m.role]}
        class="bg-inset border-border mono shrink-0 rounded-[6px] border px-2 text-[11px]"
        style="min-height:var(--tap)"
      >
        <option value="viewer">viewer</option>
        <option value="member">member</option>
        <option value="admin">admin</option>
        <option value="owner">owner</option>
      </select>
      <button onclick={() => void remove(m)} aria-label="Remove {m.email}" class="text-muted-foreground hover:text-coral tap shrink-0 rounded-[6px]">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  {/each}
</div>

<div class="mt-4 flex flex-wrap gap-2">
  <input
    bind:value={email}
    type="email"
    placeholder="invite by email"
    aria-label="Email to invite"
    onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void invite(); } }}
    class="bg-inset border-border focus:border-marigold min-w-0 flex-1 rounded-[8px] border px-3 py-2 text-xs"
  />
  <select bind:value={role} aria-label="Role for the invitee" class="bg-inset border-border mono rounded-[8px] border px-2 text-[11px]" style="min-height:var(--tap)">
    <option value="viewer">viewer</option>
    <option value="member">member</option>
    <option value="admin">admin</option>
    <option value="owner">owner</option>
  </select>
  <Button variant="outline" onclick={() => void invite()} disabled={busy || email.trim() === ''}>Invite</Button>
</div>
<p class="text-muted-foreground mt-2 text-[11px] leading-relaxed">
  {role}: {HELP[role]}. No email is sent — they sign in with GitHub and find this workspace waiting.
</p>

{#if error}<p class="text-coral mt-3 text-xs leading-relaxed">{error}</p>{/if}
