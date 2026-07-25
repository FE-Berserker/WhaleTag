/**
 * AI draft bus — hands an extension-initiated prompt draft (pdf-viewer's
 * marquee "ask AI") to the AI panel. Two channels, one source:
 *
 *  - `whale:ai-draft` CustomEvent for an ALREADY-mounted panel, and
 *  - a module-level `pending` slot the panel drains on mount.
 *
 * The slot exists because AiPanel is `React.lazy`: the host opens the panel
 * and fires the event synchronously, so on first use the chunk is still
 * loading and the event is lost. Module scope (NOT redux) is deliberate —
 * the `ai` slice is redux-persist'd wholesale and a draft must not survive
 * a restart.
 */
export interface AiDraftPayload {
  /** Source file path (becomes the attachment path). */
  path: string;
  /** 1-based page number the selection came from. */
  page?: number;
  /** Extracted text (may be empty for scans). */
  text: string;
  /** Cropped region screenshot as a PNG data URL. */
  imageDataUrl?: string;
  /** The user's (edited) question — set when it came from the
   *  AskQuestionDialog; the panel sends it immediately. */
  question?: string;
}

export const AI_DRAFT_EVENT = 'whale:ai-draft';

let pending: AiDraftPayload | null = null;

/** ExtensionHost entry point: store + notify. */
export function postAiDraft(detail: AiDraftPayload): void {
  pending = detail;
  // `window.CustomEvent`, not the global: jsdom's dispatchEvent rejects
  // Event objects from a different realm (prod: they're the same class).
  window.dispatchEvent(new window.CustomEvent(AI_DRAFT_EVENT, { detail }));
}

/** Drain the pending slot (AiPanel on mount, and after handling an event so
 *  a later mount doesn't re-apply a stale draft). */
export function consumeAiDraft(): AiDraftPayload | null {
  const d = pending;
  pending = null;
  return d;
}
