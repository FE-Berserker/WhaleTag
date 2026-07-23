import type {
  AskUserAnswers,
  AskUserQuestionItem,
} from '../../../shared/ai-types';

/**
 * Per-question selection state for the AskUserQuestion modal. Pure module so
 * the answer-mapping logic is testable without mounting the Dialog.
 */
export interface AskUserSelection {
  /** Chosen option labels (at most one unless the question is multiSelect). */
  selected: string[];
  /** Whether the built-in "Other" choice is active. */
  otherChecked: boolean;
  /** Free text typed for "Other" (the answer value itself, never the word
   *  "Other" — per the SDK's AskUserQuestion contract). */
  other: string;
}

/** Initial (empty) selection state for each question, keyed by question text. */
export function emptyAskUserSelections(
  questions: AskUserQuestionItem[]
): Record<string, AskUserSelection> {
  const out: Record<string, AskUserSelection> = {};
  for (const q of questions) {
    out[q.question] = { selected: [], otherChecked: false, other: '' };
  }
  return out;
}

/**
 * Build the SDK `answers` map: question text → selected label(s). Multi-select
 * answers are joined with ', '; an active "Other" contributes its free text.
 * Returns `null` when any question has no answer at all (the modal keeps the
 * submit button disabled in that case).
 */
export function buildAskUserAnswers(
  questions: AskUserQuestionItem[],
  selections: Record<string, AskUserSelection>
): AskUserAnswers | null {
  const answers: AskUserAnswers = {};
  for (const q of questions) {
    const sel = selections[q.question];
    const parts: string[] = sel ? [...sel.selected] : [];
    const other = sel?.other.trim();
    if (sel?.otherChecked && other) parts.push(other);
    if (parts.length === 0) return null;
    answers[q.question] = parts.join(', ');
  }
  return answers;
}
