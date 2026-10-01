/**
 * The label catalogue (migration 0010).
 *
 * `Card.labels` has been in the contract since the Card schema existed and in `docs/01`'s entity
 * list just as long, with no column and no table behind it. This is the table.
 *
 * Applied labels are stored on the card as **ids**, in the board's Durable Object. Ids rather than
 * names so that renaming a label does not orphan every card carrying it, and in the DO rather than
 * here because a card's own fields belong with the card.
 */
import { newId } from '../ids';

/**
 * How a label came to exist — the same distinction `capabilities` already carries
 * (`CapabilityOrigin`, `db/capabilities.ts`) for the same reason: `declared` means someone named
 * it deliberately, `inferred` means it was typed into a card's Labels field and registered on the
 * spot (`resolveLabelNames`, below). Recorded rather than hidden because "which of these did
 * nobody ever mean to create?" is exactly the question an operator needs to ask to find a typo
 * after the fact — the question `LabelManager.svelte` exists to let them ask.
 */
export type LabelOrigin = 'declared' | 'inferred';

/**
 * `origin`, not `created_by` — migration 0011 added both, but nothing reads `created_by` (no
 * route, no UI asks "who typed this"), and selecting a column nothing uses is exactly the
 * unexamined-field habit this file's own `origin` omission was an instance of. Add it back the
 * day something actually needs it.
 */
const COLUMNS = 'id, tenant_id AS tenantId, name, colour, origin, created_at AS createdAt';

export interface LabelRecord {
  id: string;
  tenantId: string;
  name: string;
  colour: string;
  origin: LabelOrigin;
  createdAt: string;
}

/**
 * Is this D1's own report of a `labels` name collision — either `0010`'s original
 * `UNIQUE (tenant_id, name)` or `0011`'s case-insensitive `labels_tenant_name_nocase` index?
 * SQLite's constraint-failure message names the COLUMNS a violated constraint covers, not the
 * constraint or index itself, and both of these cover the same two columns — so both produce the
 * identical message this matches, byte for byte. Verified against the real D1/Miniflare engine in
 * `test/labels-rest.test.ts`'s case-insensitive duplicate test, not assumed from a standalone
 * SQLite session.
 *
 * Narrow on purpose: `POST /v1/labels`'s catch must convert this one failure into a 409 sentence
 * and let everything else (a transient D1 error, anything) fall through to `unexpected(err)`
 * unaltered, rather than mislabelling every failure as a name collision and discarding the real
 * error — which is what an unnarrowed `catch { return 409 }` did. `resolveLabelNames` below reuses
 * this same matcher for the same reason: a second, independent string check is a second place for
 * the two to drift apart.
 */
export function isLabelNameCollision(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? '';
  return message.includes('UNIQUE constraint failed: labels.tenant_id, labels.name');
}

export async function listLabels(db: D1Database, tenantId: string): Promise<LabelRecord[]> {
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM labels WHERE tenant_id = ? ORDER BY name ASC`)
    .bind(tenantId)
    .all<LabelRecord>();
  return results ?? [];
}

export async function createLabel(
  db: D1Database,
  tenantId: string,
  input: { name: string; colour: string },
): Promise<LabelRecord> {
  const name = input.name.trim();
  if (name === '') throw new Error('a label needs a name');
  const id = newId('lbl');
  await db
    .prepare(`INSERT INTO labels (id, tenant_id, name, colour) VALUES (?, ?, ?, ?)`)
    .bind(id, tenantId, name, input.colour)
    .run();
  const row = await labelById(db, tenantId, id);
  if (!row) throw new Error('label vanished immediately after insert');
  return row;
}

export async function labelById(db: D1Database, tenantId: string, id: string): Promise<LabelRecord | null> {
  return (
    (await db
      .prepare(`SELECT ${COLUMNS} FROM labels WHERE tenant_id = ? AND id = ?`)
      .bind(tenantId, id)
      .first<LabelRecord>()) ?? null
  );
}

export async function updateLabel(
  db: D1Database,
  tenantId: string,
  id: string,
  patch: { name?: string; colour?: string },
): Promise<LabelRecord | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new Error('a label needs a name');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.colour !== undefined) {
    sets.push('colour = ?');
    params.push(patch.colour);
  }
  if (sets.length === 0) return labelById(db, tenantId, id);
  await db
    .prepare(`UPDATE labels SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ?`)
    .bind(...params, tenantId, id)
    .run();
  return labelById(db, tenantId, id);
}

/**
 * Deletion is permissive: cards may keep a dead id.
 *
 * Refusing to delete a label in use would mean a fan-out read across every board's Durable Object
 * to answer "is it in use?" — a great deal of machinery to prevent a stale chip. Readers ignore
 * unknown ids instead.
 */
export async function deleteLabel(db: D1Database, tenantId: string, id: string): Promise<boolean> {
  const res = await db.prepare(`DELETE FROM labels WHERE tenant_id = ? AND id = ?`).bind(tenantId, id).run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * A label nobody chose a colour for. Neutral, not decorative: a person who wants a real colour
 * still has `PATCH /v1/labels/:id`, or `supi label add` if they meant to declare it up front.
 */
const INFERRED_LABEL_COLOUR = '#8a8a8a';

/**
 * Turn the names a person typed into label ids, registering any that do not exist yet.
 *
 * `origin: 'inferred'` is the same answer `capabilities` gives for a tag that "appeared as a stage
 * owner and was registered on first use" (migration 0006). The alternative — refusing a name that
 * is not already in the catalogue — would mean a person cannot label a card without first visiting
 * a management screen, which is why the free-text input existed in the first place.
 *
 * Matching is by name within the tenant, case-insensitively (migration 0011's
 * `labels_tenant_name_nocase`), so "Urgent" and "urgent" do not become two labels. The lookup and
 * the unique index have to agree on that, or this function is how a tenant ends up with two rows
 * that read identically to a person.
 *
 * The lookup-then-insert per name is not atomic, so two concurrent callers resolving the same
 * brand-new name in one tenant can both miss the SELECT and both attempt the INSERT — only one
 * wins. The loser does not error the caller: it catches the collision (`isLabelNameCollision`,
 * the same matcher `POST /v1/labels` uses) and re-runs the lookup to hand back the WINNER's id,
 * which is the row that is actually there. Refusing instead would surface as an ordinary drawer
 * save turning into an unexplained 500 for whichever of two people typed the same new label first
 * — rare with one person and one drawer, but real, and the new case-insensitive index makes two
 * spellings collide where before this migration they would not have.
 */
export async function resolveLabelNames(
  db: D1Database,
  tenantId: string,
  names: string[],
  createdBy: string | null,
): Promise<string[]> {
  // Blank entries are not names — same filter the drawer already applies before sending anything.
  const wanted = names.map((n) => n.trim()).filter((n) => n !== '');
  const ids: string[] = [];
  for (const name of wanted) {
    const existing = await lookupLabelId(db, tenantId, name);
    if (existing) {
      ids.push(existing);
      continue;
    }
    const id = newId('lbl');
    try {
      await db
        .prepare(
          `INSERT INTO labels (id, tenant_id, name, colour, origin, created_by) VALUES (?, ?, ?, ?, 'inferred', ?)`,
        )
        .bind(id, tenantId, name, INFERRED_LABEL_COLOUR, createdBy)
        .run();
      ids.push(id);
    } catch (err) {
      if (!isLabelNameCollision(err)) throw err;
      // Lost the race: something else (another request, `POST /v1/labels`, another name in this
      // same call resolving to the same spelling) created this name between our lookup and our
      // insert. Their row is what is actually in the catalogue now — use it rather than erroring.
      const winner = await lookupLabelId(db, tenantId, name);
      if (!winner) throw err; // the collision was real but the row is gone again — surface the original error rather than inventing a result
      ids.push(winner);
    }
  }
  return ids;
}

async function lookupLabelId(db: D1Database, tenantId: string, name: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT id FROM labels WHERE tenant_id = ? AND name = ? COLLATE NOCASE`)
    .bind(tenantId, name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Which of these ids do not exist in this tenant — so a card write can be refused before it lands. */
export async function unknownLabelIds(db: D1Database, tenantId: string, ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids)].filter((id) => id.trim() !== '');
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(', ');
  const { results } = await db
    .prepare(`SELECT id FROM labels WHERE tenant_id = ? AND id IN (${placeholders})`)
    .bind(tenantId, ...wanted)
    .all<{ id: string }>();
  const live = new Set((results ?? []).map((r) => r.id));
  return wanted.filter((id) => !live.has(id));
}
