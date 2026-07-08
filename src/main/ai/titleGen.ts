/**
 * Auto conversation title generation. Sends a tiny non-streaming completion
 * describing the conversation so far and clips the reply into a short title.
 *
 * Only runs for HTTP providers (Ollama / OpenAI-compatible) — the Claude CLI
 * path is intentionally skipped because spending a CLI cold-start on a title
 * would regress the warm-query latency work (and titles from the first user
 * message are good enough there).
 */
import type {
  AiSettingsSnapshot,
  ChatMessage,
} from '../../shared/ai-types';
import { getSecret, SECRET_NAMES } from './security/secretStore';

/** Max length of a generated title (the model is asked for 2–6 words). */
export const TITLE_MAX = 60;

/**
 * Build the message array for the title request: a strict system instruction
 * plus a trimmed transcript (first + last exchange, to stay cheap).
 */
export function titleMessages(
  history: ChatMessage[]
): Array<{ role: string; content: string }> {
  const transcript = history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role}: ${(m.displayContent || m.content).slice(0, 400)}`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'Generate a concise 2–6 word title for the conversation. Reply with ONLY the title — no quotes, no trailing punctuation, no preamble.',
    },
    { role: 'user', content: transcript || '(empty conversation)' },
  ];
}

/** Clip a raw model reply to a single-line title ≤ TITLE_MAX chars. */
export function clipTitle(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0].trim().replace(/^["'`]|["'`]$/g, '');
  const clean = firstLine.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX)}…` : clean;
}

/**
 * Generate a title. Returns '' for the Claude CLI provider (skipped) or when
 * the model returns nothing usable.
 */
export async function generateTitle(input: {
  settings: AiSettingsSnapshot;
  history: ChatMessage[];
}): Promise<string> {
  const { settings, history } = input;
  if (settings.provider === 'claude-cli') return '';

  const isOllama = settings.provider === 'ollama';
  const base = (isOllama ? settings.ollamaUrl : settings.openaiUrl).replace(
    /\/+$/,
    ''
  );
  const apiKey = isOllama ? '' : getSecret(SECRET_NAMES.openai);

  let resp: Response;
  try {
    resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: settings.model,
        messages: titleMessages(history),
        stream: false,
      }),
    });
  } catch {
    return '';
  }
  if (!resp.ok) return '';
  try {
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return clipTitle(data.choices?.[0]?.message?.content ?? '');
  } catch {
    return '';
  }
}
