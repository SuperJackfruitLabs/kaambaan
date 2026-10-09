import { describe, expect, it } from 'vitest';
import { manualDeliveryItems } from './approval-delivery';

describe('manual approval delivery view', () => {
  it('derives copy-ready exact text and downloadable media from authoritative canonical bytes', () => {
    const canonical = {
      items: [
        {
          index: 0,
          text: 'Exact copy — unchanged.\nSecond line.',
          media: [
            {
              objectRef: 'https://media.example.invalid/frozen/image.png',
              sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              mime: 'image/png',
              size: 123,
              altText: 'Fixture alt text',
            },
          ],
        },
      ],
    };

    expect(manualDeliveryItems(canonical)).toEqual([
      {
        index: 0,
        text: 'Exact copy — unchanged.\nSecond line.',
        media: [
          {
            href: 'https://media.example.invalid/frozen/image.png',
            filename: 'image.png',
            altText: 'Fixture alt text',
            digest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        ],
      },
    ]);
  });

  it('refuses malformed mutable-looking items instead of inventing copy', () => {
    expect(manualDeliveryItems({ items: [{ index: 0, text: 42, media: [] }] })).toEqual([]);
    expect(manualDeliveryItems({})).toEqual([]);
  });
});
