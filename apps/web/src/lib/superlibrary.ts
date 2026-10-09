// apps/web/src/lib/superlibrary.ts
/**
 * Superlibrary from the card drawer (superlibrary spec §9 Embedding, §11). Every call carries the
 * signed-in person's own Superlibrary-audience token (hub-token.ts `libraryToken`), so Superlibrary
 * decides what this person may see. No cookies cross: `credentials: 'omit'`.
 */
import { forgetLibraryToken, libraryConfigured, libraryToken } from '$lib/hub-token';
import type { EmbedGrant, MountOptions, Scope, ShareInfo } from '$lib/vendor/superlibrary-embed/superlibrary-embed.js';

export const LIBRARY_URL = 'https://app.superlibrary.dev';
/** A hung Superlibrary ends in the retryable message rather than a spinner. */
const LIBRARY_TIMEOUT_MS = 10_000;
const ITEM_PATH = /^\/a\/(itm_[0-9a-f]{16})(?:\/v\/([1-9][0-9]*))?\/?$/;

/** The item (and version) a reference names, when it is a link to this deployment's Superlibrary. */
export function libraryRef(url: string): { itemId: string; version?: number } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== LIBRARY_URL) return null;
  const m = ITEM_PATH.exec(u.pathname);
  if (!m) return null;
  return m[2] ? { itemId: m[1]!, version: Number(m[2]) } : { itemId: m[1]! };
}

export class LibraryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export async function libraryFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await libraryToken();
  if (!token) throw new LibraryError(0, libraryConfigured() ? 'no_token' : 'not_configured');
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LIBRARY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${LIBRARY_URL}${path}`, { ...init, headers, credentials: 'omit', signal: ctl.signal });
  } catch {
    throw new LibraryError(0, 'unreachable');
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) forgetLibraryToken();
  return res;
}

async function jsonOf<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new LibraryError(res.status, b.error ?? `http_${res.status}`);
  }
  return (await res.json()) as T;
}

interface ItemRead { item: { scope: Scope; title: string; createdBy: string; audience?: string }; versions: Array<{ version: number; revokedAt: string | null }> }

/** The host's callbacks for `mountArtifact` (superlibrary packages/embed README, "The host's duties"). */
export function embedCallbacks(): Pick<MountOptions, 'getEmbedUrl' | 'getVersions' | 'getShareInfo' | 'setScope'> {
  // One mount reads each item once: the embed asks for versions and share info separately.
  const reads = new Map<string, Promise<ItemRead>>();
  const readItem = (itemId: string): Promise<ItemRead> => {
    let p = reads.get(itemId);
    if (!p) {
      p = libraryFetch(`/api/v1/items/${itemId}`).then((r) => jsonOf<ItemRead>(r));
      reads.set(itemId, p);
      p.catch(() => reads.delete(itemId));
    }
    return p;
  };
  return {
    getEmbedUrl: async ({ itemId, version }) =>
      jsonOf<EmbedGrant>(await libraryFetch(`/api/v1/items/${itemId}/embed`, { method: 'POST', body: JSON.stringify(version ? { version } : {}) })),
    getVersions: async ({ itemId }) =>
      (await readItem(itemId)).versions.filter((v) => !v.revokedAt).map((v) => v.version),
    getShareInfo: async ({ itemId }): Promise<ShareInfo> => {
      const [{ item }, me] = await Promise.all([
        readItem(itemId),
        libraryFetch('/api/v1/me').then((r) => jsonOf<{ principalId: string; role: 'owner' | 'member' }>(r)).catch(() => null),
      ]);
      // Superlibrary decides on widening; this only offers it to whom it would allow (its plan D12).
      return { scope: item.scope, title: item.title, boardVisible: item.audience === 'board', canWiden: me !== null && (item.createdBy === me.principalId || me.role === 'owner') };
    },
    setScope: async ({ itemId, scope }) => {
      const done = await jsonOf(await libraryFetch(`/api/v1/items/${itemId}/scope`, { method: 'POST', body: JSON.stringify({ scope }) }));
      // The embed asks for share info right after a widen; it must see the new scope, not the cached read.
      reads.delete(itemId);
      return done;
    },
  };
}

const SENTENCES: Record<string, string> = {
  not_configured: 'Superlibrary is not set up here.',
  no_token: 'Previews need you signed in through your workspace account.',
  product_not_enabled: 'Superlibrary is not enabled for this workspace.',
  not_found: 'This artifact is not there, or you cannot see it.',
  revoked: 'This artifact was revoked.',
  expired: 'This artifact has expired.',
};
export function sentenceFor(e: unknown): string {
  return (e instanceof LibraryError && SENTENCES[e.code]) || 'The preview could not be loaded. Try again in a moment.';
}
export interface RelatedLite { itemId: string; title: string; kind: 'artifact' | 'work-record'; outcome: string; snippet: string; url: string }

/** Items related to this card, as Superlibrary sees them for this person (its visibility rule, spec §4). */
export async function relatedForCard(cardId: string): Promise<RelatedLite[]> {
  const body = await jsonOf<{ items: RelatedLite[] }>(await libraryFetch('/api/v1/related', { method: 'POST', body: JSON.stringify({ cardId, limit: 5 }) }));
  return body.items;
}

const OUTCOME_WORDS: Record<string, string> = {
  approved: 'Approved', completed: 'Completed', 'in-progress': 'In progress', superseded: 'Superseded', rejected: 'Rejected', failed: 'Failed', abandoned: 'Abandoned',
};
/** Superlibrary is not there for this person at all: show nothing rather than an apology on every card. */
export const isAbsent = (e: unknown) => e instanceof LibraryError && (e.code === 'not_configured' || e.code === 'product_not_enabled');

export const outcomeWord = (o: string) => OUTCOME_WORDS[o] ?? o;
