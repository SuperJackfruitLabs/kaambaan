// apps/web/src/lib/vendor/superlibrary-embed/vendored.test.ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = import.meta.dirname;
const manifest = JSON.parse(readFileSync(join(dir, 'VENDORED.json'), 'utf8')) as { source: string; commit: string; files: Record<string, string> };

describe('the vendored @superlibrary/embed (decision O3)', () => {
  it('every file is exactly the one VENDORED.json pins, from a named commit', () => {
    expect(Object.keys(manifest.files).sort()).toEqual(['superlibrary-embed.d.ts', 'superlibrary-embed.js']);
    for (const [f, sha] of Object.entries(manifest.files)) {
      expect(createHash('sha256').update(readFileSync(join(dir, f))).digest('hex'), `${f} differs from its pin: re-run scripts/vendor-superlibrary-embed.sh`).toBe(sha);
    }
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
  });
  it('imports nothing: it runs on its own', () => {
    expect(readFileSync(join(dir, 'superlibrary-embed.js'), 'utf8')).not.toMatch(/^\s*import[\s{*]/m);
  });
});
