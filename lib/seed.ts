import { messageText, pathTo } from './claude';
import type { ChatMessage, ConversationTree } from './types';

/** Render one message including any document attachments' extracted text + image notes. */
function renderMessage(m: ChatMessage): string {
  const role = m.sender === 'human' ? 'Human' : 'Assistant';
  const parts: string[] = [];
  const body = messageText(m);
  if (body) parts.push(body);
  // Document attachments are stored as extracted text — include it so the tangent is
  // faithful for PDF/doc context (this content isn't in the message text otherwise).
  for (const a of m.attachments || []) {
    if (a.extracted_content) parts.push(`[Attached document: ${a.file_name}]\n${a.extracted_content}`);
    else if (a.file_name) parts.push(`[Attached document: ${a.file_name}]`);
  }
  // Images/binary files are noted textually (their pixels aren't carried into v1 tangents).
  const files = (m.files_v2?.length ? m.files_v2 : m.files) || [];
  for (const f of files) {
    parts.push(`[Attached image: ${f.file_name || 'file'}]`);
  }
  return parts.length ? `${role}: ${parts.join('\n\n')}` : '';
}

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
  const transcript = chain.map(renderMessage).filter(Boolean).join('\n\n');

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
