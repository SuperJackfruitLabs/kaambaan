/**
 * Escape closes the card, unless something inside it already took the key: the embedded viewer
 * (panels, the widen confirmation, full screen) listens on the document and calls preventDefault.
 */
export function closeCardOnEscape(e: KeyboardEvent, close: () => void): void {
  if (e.key === 'Escape' && !e.defaultPrevented) close();
}
