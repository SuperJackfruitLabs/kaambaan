export interface ManualDeliveryMedia {
  href: string;
  filename: string;
  altText: string;
  digest: string;
}

export interface ManualDeliveryItem {
  index: number;
  text: string;
  media: ManualDeliveryMedia[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function filenameFor(href: string, index: number): string {
  try {
    const pathname = new URL(href).pathname;
    const name = pathname.split('/').filter(Boolean).at(-1);
    return name || `media-${index + 1}`;
  } catch {
    return `media-${index + 1}`;
  }
}

/** Read only frozen canonical subject fields; malformed entries are never repaired or guessed. */
export function manualDeliveryItems(canonical: Record<string, unknown>): ManualDeliveryItem[] {
  if (!Array.isArray(canonical.items)) return [];
  const items: ManualDeliveryItem[] = [];
  for (const candidate of canonical.items) {
    const item = record(candidate);
    if (!item || typeof item.index !== 'number' || typeof item.text !== 'string' || !Array.isArray(item.media)) return [];
    const media: ManualDeliveryMedia[] = [];
    for (const [mediaIndex, raw] of item.media.entries()) {
      const value = record(raw);
      if (!value || typeof value.objectRef !== 'string' || typeof value.sha256 !== 'string') return [];
      media.push({
        href: value.objectRef,
        filename: filenameFor(value.objectRef, mediaIndex),
        altText: typeof value.altText === 'string' ? value.altText : '',
        digest: value.sha256,
      });
    }
    items.push({ index: item.index, text: item.text, media });
  }
  return items;
}
