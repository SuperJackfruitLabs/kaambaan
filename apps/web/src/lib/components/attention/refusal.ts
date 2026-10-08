/** The sentence to show for a refused request: the server's own message when it sent one. */
export async function refusalOf(res: Response): Promise<string | null> {
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const err = body?.error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') return (err as { message: string }).message;
  return `refused (${res.status})`;
}
