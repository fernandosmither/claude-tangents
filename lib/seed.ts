import { messageText, pathTo } from './claude';
import type { AttachmentDoc, ChatMessage, ContentBlock, ConversationTree, MediaPayload } from './types';

const ARTIFACT_CAP = 16000; // chars per embedded artifact, to keep the seed within context limits
const cap = (s: string) => (s.length > ARTIFACT_CAP ? `${s.slice(0, ARTIFACT_CAP)}\n…(truncated)` : s);

/** Text of a generated artifact / file carried in a tool_use block (its content is in the tree). */
function artifactText(b: ContentBlock): string {
  const name = typeof b.name === 'string' ? b.name : '';
  const input = b.input && typeof b.input === 'object' ? (b.input as Record<string, unknown>) : null;
  if (!input) return '';
  // new file-based artifacts (create_file → file_text)
  if (name === 'create_file' && typeof input.file_text === 'string') {
    const path = typeof input.path === 'string' ? input.path : 'file';
    return `[File: ${path}]\n\`\`\`\n${cap(input.file_text)}\n\`\`\``;
  }
  // classic artifacts (tool name "artifacts" → content)
  if (name === 'artifacts' && typeof input.content === 'string') {
    const title = typeof input.title === 'string' ? input.title : 'artifact';
    return `[Artifact: ${title}]\n\`\`\`\n${cap(input.content)}\n\`\`\``;
  }
  return '';
}

/**
 * Render one message: its visible text plus any generated artifact/file content. Uploaded documents
 * and images are NOT inlined here — they ride the completion's native `attachments`/`files` arrays
 * (see collectMedia), which is more faithful and needs no re-upload.
 */
function renderMessage(m: ChatMessage): string {
  const role = m.sender === 'human' ? 'Human' : 'Assistant';
  const parts: string[] = [];
  const body = messageText(m);
  if (body) parts.push(body);
  if (Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b.type === 'tool_use') {
        const a = artifactText(b);
        if (a) parts.push(a);
      }
    }
  }
  return parts.length ? `${role}: ${parts.join('\n\n')}` : '';
}

/**
 * Gather the source thread's media (path up to & including the anchor) to carry into the tangent
 * without re-uploading: org-scoped `file_uuid`s (re-linked), documents (re-attached with their
 * inline `extracted_content`), and connector refs. Generated artifacts ride the seed text instead.
 */
export function collectMedia(tree: ConversationTree, anchorMessageUuid: string): MediaPayload {
  const chain = pathTo(tree, anchorMessageUuid);
  const files: string[] = [];
  const fileSeen = new Set<string>();
  const attachments: AttachmentDoc[] = [];
  const attSeen = new Set<string>();
  const sync_sources: unknown[] = [];
  for (const m of chain) {
    for (const f of [...(m.files || []), ...(m.files_v2 || [])]) {
      const id = f.file_uuid || f.uuid;
      if (id && !fileSeen.has(id)) {
        fileSeen.add(id);
        files.push(id);
      }
    }
    for (const a of m.attachments || []) {
      const key = a.id || a.file_name;
      if (a.extracted_content && key && !attSeen.has(key)) {
        attSeen.add(key);
        attachments.push({
          file_name: a.file_name,
          file_type: a.file_type,
          file_size: a.file_size,
          extracted_content: a.extracted_content,
        });
      }
    }
    for (const s of m.sync_sources || []) sync_sources.push(s);
  }
  return { files, attachments, sync_sources };
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
