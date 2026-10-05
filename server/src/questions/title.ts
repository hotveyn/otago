import { collapseWhitespace, firstLine, truncateGraphemes } from '../text.js';
import { QUESTION_TITLE_MAX_GRAPHEMES } from './types.js';

/** Question given to the agent when the user sent files without text. */
export const EMPTY_TEXT_QUESTION =
  'The user sent the attached files without a message. Look at them and respond helpfully.';

/**
 * Display title of a question: the first non-empty line of `text`, whitespace collapsed, cut
 * to QUESTION_TITLE_MAX_GRAPHEMES graphemes + `…`. Files-only message: the file names joined
 * by `, ` (same cut).
 */
export function questionTitle(text: string, fileNames: readonly string[]): string {
  const line = collapseWhitespace(firstLine(text));
  return truncateGraphemes(line || fileNames.join(', '), QUESTION_TITLE_MAX_GRAPHEMES, '…');
}

/** What the agent is asked: the text, or EMPTY_TEXT_QUESTION for a files-only message. */
export function agentQuestion(text: string): string {
  return text || EMPTY_TEXT_QUESTION;
}

/** What the naming call sees as the question: the text, or `Attached files: <names>`. */
export function namingQuestion(text: string, fileNames: readonly string[]): string {
  return text || `Attached files: ${fileNames.join(', ')}`;
}
