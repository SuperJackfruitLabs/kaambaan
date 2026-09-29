/**
 * Recognise a reference URL (docs/06 §1).
 *
 * The shapes and the host rules now live in `@superpipeline/contract`'s provider registry, so
 * "which providers exist" is one list rather than a function here and an enum there. This stays as
 * the API's entry point because `resolveReferenceInput` and the MCP wire both call it, and moving
 * those is a bigger change than this slice.
 */
import { recognise, type RecognisedReference } from '@superpipeline/contract';

export type { RecognisedReference };

export function recognizeReference(url: string, forgeHost?: string | null): RecognisedReference {
  return recognise(url, { forgeHost });
}
