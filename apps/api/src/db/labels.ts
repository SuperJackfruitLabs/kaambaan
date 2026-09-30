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

const COLUMNS = 'id, tenant_id AS tenantId, name, colour, created_at AS createdAt';

export interface LabelRecord {
  id: string;
  tenantId: string;
  name: string;
  colour: string;
  createdAt: string;
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
