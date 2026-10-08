/**
 * Nothing in the web app is sized in `vh`.
 *
 * On a phone `100vh` is the LARGEST viewport — the height with the browser's toolbars scrolled
 * away. The app frame was `h-screen overflow-hidden`, so with a toolbar showing the frame was
 * taller than the screen and could not scroll: on an iPhone in Arc the end of the Operate page and
 * the whole bottom nav (the only sign-out on a phone) sat under the toolbar (2026-10-08).
 *
 * A browser test cannot catch this. Playwright has no toolbar, so its `vh` and `dvh` are always the
 * same number and a `100vh` frame fits at any viewport size. The rule therefore lives here, in the
 * source: size against the dynamic or small viewport (`h-viewport` / `min-h-viewport` in app.css,
 * or `dvh`/`svh` directly). A `vh` value is allowed only as the old-browser fallback that app.css
 * declares just before its `dvh` replacement, marked `vh-fallback`.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(svelte|css|html)$/.test(name) ? [path] : [];
  });
}

/** Code only: a comment explaining why `100vh` is wrong is not a use of it. */
function code(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.includes('vh-fallback') ? '' : line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const LARGE_VIEWPORT = /\b(?:min-h-screen|max-h-screen|h-screen)\b|(?<![\w-])\d+(?:\.\d+)?vh\b/g;

describe('viewport units', () => {
  it('no component sizes itself against the large viewport', () => {
    const found: string[] = [];
    for (const path of [...files(SRC), join(SRC, '..', 'src', 'app.html')]) {
      for (const m of code(readFileSync(path, 'utf8')).matchAll(LARGE_VIEWPORT)) {
        found.push(`${relative(SRC, path)}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every vh fallback is followed by its dynamic replacement', () => {
    const css = readFileSync(join(SRC, 'app.css'), 'utf8');
    expect(css).toMatch(/@supports \(height: 100dvh\)[\s\S]*\.h-viewport\s*\{\s*height: 100dvh;/);
    expect(css).toMatch(/max-height: 46vh; \/\* vh-fallback \*\/\s*max-height: 46svh;/);
  });

  it('the page is laid out edge to edge, so safe-area insets are real', () => {
    const html = readFileSync(join(SRC, 'app.html'), 'utf8');
    expect(html).toMatch(/<meta name="viewport" content="[^"]*viewport-fit=cover/);
  });
});
