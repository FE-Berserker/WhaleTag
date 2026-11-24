/** Excalidraw 0.18.1 restore() is deliberately total: `{}`, `null`, library
 * exports and unrelated JSON all become an empty scene instead of throwing.
 * Reject those inputs before they can turn into a valid-looking empty document
 * that Save would write over the source file. A truly empty file remains a new
 * scene; a scene may omit `elements`, but a present value must be an array. */
export function parseExcalidrawScene(content: string): Record<string, unknown> {
  if (!content.trim()) return {};
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('not an Excalidraw scene');
  }
  const candidate = parsed as { type?: unknown; elements?: unknown };
  if (
    candidate.type !== 'excalidraw' ||
    (candidate.elements !== undefined && !Array.isArray(candidate.elements))
  ) {
    throw new Error('not an Excalidraw scene');
  }
  return candidate as Record<string, unknown>;
}
