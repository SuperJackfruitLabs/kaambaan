import { describe, expect, it } from 'vitest';
import { recogniseParts } from '../src/providers';

const H = 'app.superlibrary.dev';

describe('Superlibrary references', () => {
  it('recognises an item link as a Superlibrary artifact', () => {
    expect(recogniseParts(H, ['a', 'itm_0123456789abcdef'])).toMatchObject({ provider: 'superlibrary', sourceType: 'artifact', externalId: 'itm_0123456789abcdef' });
  });
  it('recognises a versioned item link as the same item', () => {
    expect(recogniseParts(H, ['a', 'itm_0123456789abcdef', 'v', '3'])).toMatchObject({ provider: 'superlibrary', sourceType: 'artifact', externalId: 'itm_0123456789abcdef' });
  });
  it('does not claim other paths on the host as artifacts', () => {
    expect(recogniseParts(H, ['upload'])).toEqual({ provider: 'superlibrary', sourceType: 'url' });
    expect(recogniseParts(H, ['a', 'itm_xyz'])).toEqual({ provider: 'superlibrary', sourceType: 'url' });
    expect(recogniseParts(H, ['a', 'itm_0123456789abcdef', 'v', '3', 'extra'])).toEqual({ provider: 'superlibrary', sourceType: 'url' });
    expect(recogniseParts(H, ['a', 'itm_0123456789abcdef', 'x'])).toEqual({ provider: 'superlibrary', sourceType: 'url' });
    expect(recogniseParts(H, ['a', 'itm_0123456789abcdef', 'v', '0'])).toEqual({ provider: 'superlibrary', sourceType: 'url' });
  });
  it('does not claim another host', () => {
    expect(recogniseParts('example.test', ['a', 'itm_0123456789abcdef'])).toMatchObject({ provider: 'url' });
  });
});
