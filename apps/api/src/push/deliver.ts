/**
 * Outbound push delivery (docs/05 §4): sign a queued delivery and POST it. Pull is the default; push
 * is an accelerator that just tells an agent to `claim`. The sender is injected so the send is
 * testable and so durability (Queue + Workflow with exponential backoff) can wrap it in production.
 */
import { hmacSignatureHeader } from '../crypto/hmac';

export interface PushDelivery {
  id: number;
  url: string;
  body: string; // JSON string — the exact bytes that are signed
  token: string; // per-config signing secret
}

export type PushSender = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ status: number }>;

/** How long one push may take. A slow or down endpoint must not hold up the rest of the drain. */
export const PUSH_TIMEOUT_MS = 10_000;

export interface PushOutcome {
  id: number;
  ok: boolean;
  status: number;
}

export async function signAndSend(delivery: PushDelivery, sender: PushSender, timeoutMs = PUSH_TIMEOUT_MS): Promise<PushOutcome> {
  const signature = await hmacSignatureHeader(delivery.token, delivery.body);
  let event = '';
  try {
    event = (JSON.parse(delivery.body) as { event?: string }).event ?? '';
  } catch {
    event = '';
  }
  // The abort signal cuts a real fetch; the race cuts a sender that ignores it.
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('push timed out'));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      sender(delivery.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Superpipeline-Signature': signature, 'X-Superpipeline-Event': event },
        body: delivery.body,
        signal: abort.signal,
      }),
      timedOut,
    ]);
    return { id: delivery.id, ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { id: delivery.id, ok: false, status: 0 };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
