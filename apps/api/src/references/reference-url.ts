/**
 * Recognise a reference URL (docs/06 §1).
 *
 * The shapes and the host rules live in `@superpipeline/contract`'s provider registry, so "which
 * providers exist" is one list rather than a function here and an enum there. The PARSING stays
 * here: the contract compiles with no DOM and no Node types, and the host comparison it performs
 * is a security boundary — `https://evil.com@forge.example.test/` must not read as the operator's
 * forge, and that is the platform's URL parser's job rather than a regex's.
 */
import { recogniseParts, GENERIC, type RecognisedReference } from '@superpipeline/contract';

export type { RecognisedReference };

export function recognizeReference(url: string, forgeHost?: string | null): RecognisedReference {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return GENERIC;
  }
  return recogniseParts(
    parsed.hostname.toLowerCase().replace(/^www\./, ''),
    parsed.pathname.split('/').filter(Boolean),
    { forgeHost },
  );
}
