/**
 * The P4 cutover's data step for this catalog: move tenant and user external mappings from the hub's
 * ids to the Organization plane's. Pure — the runner (`scripts/repoint-org-plane.ts`) snapshots,
 * prints, applies and re-verifies. Every UPDATE is guarded on the value it replaces.
 */
export interface RepointMapping {
  tenants: Record<string, string>;
  chosenTenants?: Record<string, string>;
  users: Record<string, string>;
}
type Row = { id: string; external_source: string | null; external_id: string | null };
export interface CatalogSnapshot { tenants: Row[]; users: Row[] }
type Move = { id: string; from: string; to: string };
export interface RepointPlan {
  statements: string[];
  tenants: Move[];
  users: Move[];
  unmapped: { tenants: string[]; users: string[] };
  conflicts: string[];
}

const FLEET = /^fleet_[0-9a-f]{20}$/;
const ORG = /^org_[0-9a-f]{20}$/;
const PRN = /^prn_[0-9a-f]{20}$/;
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

function check(mapping: RepointMapping): void {
  for (const [fleet, org] of Object.entries(mapping.tenants)) {
    if (!FLEET.test(fleet)) throw new Error(`mapping.tenants key ${fleet} is not a fleet_ id`);
    if (!ORG.test(org)) throw new Error(`mapping.tenants[${fleet}] = ${org} is not an org_ id`);
  }
  for (const [hubId, prn] of Object.entries(mapping.users)) {
    if (!PRN.test(prn)) throw new Error(`mapping.users[${hubId}] = ${prn} is not a prn_ id`);
  }
}

function update(table: 'tenants' | 'users', id: string, from: [string, string], to: [string, string]): string {
  return `UPDATE ${table} SET external_source = ${q(to[0])}, external_id = ${q(to[1])}, updated_at = datetime('now') WHERE id = ${q(id)} AND external_source = ${q(from[0])} AND external_id = ${q(from[1])};`;
}

export function planRepoint(snapshot: CatalogSnapshot, mapping: RepointMapping, direction: 'forward' | 'reverse'): RepointPlan {
  check(mapping);
  const [fromSrc, toSrc] = direction === 'forward' ? ['agentpod', 'org-plane'] : ['org-plane', 'agentpod'];
  const plan: RepointPlan = { statements: [], tenants: [], users: [], unmapped: { tenants: [], users: [] }, conflicts: [] };

  // A mapping must be one-to-one. Two fleets onto one org would plan two UPDATEs that migration
  // 0017 lets only one of win, and the reverse of a many-to-one mapping cannot know which fleet to
  // restore. Both directions refuse every entry involved, by name.
  const oneToOne = (entries: Array<[string, string]>, what: string): Array<[string, string]> => {
    const byTarget = new Map<string, string[]>();
    for (const [k, v] of entries) byTarget.set(v, [...(byTarget.get(v) ?? []), k]);
    for (const [target, keys] of byTarget) {
      if (keys.length > 1) plan.conflicts.push(`${target} is the target of more than one ${what} (${keys.sort().join(', ')})`);
    }
    return entries.filter(([, v]) => byTarget.get(v)!.length === 1);
  };
  const tenantPairs = oneToOne(Object.entries(mapping.tenants), 'fleet');
  const userPairs = oneToOne(Object.entries(mapping.users), 'hub user');
  const tenantMap: Record<string, string> = Object.fromEntries(direction === 'forward' ? tenantPairs : tenantPairs.map(([f, o]) => [o, f]));
  const userMap: Record<string, string> = Object.fromEntries(direction === 'forward' ? userPairs : userPairs.map(([h, p]) => [p, h]));

  // Tenants: group the candidates by the external id they will move from.
  const held = new Map(snapshot.tenants.filter((t) => t.external_source === toSrc).map((t) => [t.external_id!, t.id]));
  const byFrom = new Map<string, Row[]>();
  for (const t of snapshot.tenants) {
    if (t.external_source !== fromSrc || !t.external_id) continue;
    if (!(t.external_id in tenantMap)) { plan.unmapped.tenants.push(t.id); continue; }
    byFrom.set(t.external_id, [...(byFrom.get(t.external_id) ?? []), t]);
  }
  for (const [from, rows] of byFrom) {
    const to = tenantMap[from]!;
    let chosen = rows[0]!;
    if (rows.length > 1) {
      const org = direction === 'forward' ? to : from;
      const pick = mapping.chosenTenants?.[org];
      const found = rows.find((r) => r.id === pick);
      if (!found) {
        plan.conflicts.push(`${from} is linked by ${rows.length} tenants (${rows.map((r) => r.id).join(', ')}); name one in chosenTenants["${org}"]`);
        continue;
      }
      chosen = found;
      for (const r of rows) if (r !== found) plan.unmapped.tenants.push(r.id);
    }
    // Only an org-plane target is unique (migration 0017); agentpod targets may be shared.
    const holder = held.get(to);
    if (toSrc === 'org-plane' && holder && holder !== chosen.id) { plan.conflicts.push(`${to} is already held by ${holder}`); continue; }
    plan.statements.push(update('tenants', chosen.id, [fromSrc, from], [toSrc, to]));
    plan.tenants.push({ id: chosen.id, from: `${fromSrc}:${from}`, to: `${toSrc}:${to}` });
  }

  const heldUsers = new Map(snapshot.users.filter((u) => u.external_source === toSrc).map((u) => [u.external_id!, u.id]));
  for (const u of snapshot.users) {
    if (u.external_source !== fromSrc || !u.external_id) continue;
    const to = userMap[u.external_id];
    if (!to) { plan.unmapped.users.push(u.id); continue; }
    const holder = heldUsers.get(to);
    if (holder && holder !== u.id) { plan.conflicts.push(`${to} is already held by ${holder}`); continue; }
    plan.statements.push(update('users', u.id, [fromSrc, u.external_id], [toSrc, to]));
    plan.users.push({ id: u.id, from: `${fromSrc}:${u.external_id}`, to: `${toSrc}:${to}` });
  }
  plan.tenants.sort((a, b) => a.id.localeCompare(b.id));
  plan.unmapped.tenants.sort();
  return plan;
}
