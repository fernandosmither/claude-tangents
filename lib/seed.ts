import { messageText, pathTo } from './claude';
import type { ConversationTree } from './types';

export interface SeedInput {
  tree: ConversationTree;
  anchorMessageUuid: string; // the assistant message the highlight lives in
  highlight: string; // the selected text
  question: string; // the user's tangent question
}

/**
 * Build the first message for a tangent conversation: the full prior transcript
 * up to & including the anchored answer, then the quoted excerpt, then the
 * question. This is "faithful in content" — Claude sees the whole thread — and
 * the bulky transcript is hidden from the user in the iframe (only the excerpt +
 * question are surfaced in the popover header).
 */
export function buildSeed({ tree, anchorMessageUuid, highlight, question }: SeedInput): string {
  const chain = pathTo(tree, anchorMessageUuid);
  const transcript = chain
    .map((m) => {
      const role = m.sender === 'human' ? 'Human' : 'Assistant';
      const body = messageText(m);
      return body ? `${role}: ${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');

  return [
    '<prior_conversation>',
    'Below is an earlier conversation I had with you. I want to explore a tangent about one',
    'specific part of your answer, in a separate side-thread, without redirecting the main',
    'conversation. Treat the excerpt below as the focus, but use the whole thread as context.',
    '',
    transcript,
    '</prior_conversation>',
    '',
    'The specific excerpt I want to ask about:',
    '"""',
    highlight.trim(),
    '"""',
    '',
    question.trim(),
  ].join('\n');
}
