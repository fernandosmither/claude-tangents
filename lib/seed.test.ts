import { describe, it, expect } from 'vitest';
import { buildSeed, collectMedia } from './seed';
import type { ConversationTree } from './types';

const ROOT = '00000000-0000-4000-8000-000000000000';

// h1 (image + doc) → a1 (text + a created file) → h2 → a2
const tree: ConversationTree = {
  uuid: 'c',
  model: 'claude-opus-4-8',
  current_leaf_message_uuid: 'a2',
  chat_messages: [
    {
      uuid: 'h1',
      parent_message_uuid: ROOT,
      sender: 'human',
      index: 0,
      text: 'look at this',
      files: [{ file_uuid: 'IMG1', file_name: 'a.png', file_kind: 'image' }],
      attachments: [
        { id: 'D1', file_name: 'doc.txt', file_type: 'txt', file_size: 10, extracted_content: 'hello doc' },
      ],
    },
    {
      uuid: 'a1',
      parent_message_uuid: 'h1',
      sender: 'assistant',
      index: 1,
      content: [
        { type: 'text', text: 'here is a file' },
        { type: 'tool_use', name: 'create_file', input: { path: 'app.js', file_text: 'console.log(1)' } },
      ],
    },
    { uuid: 'h2', parent_message_uuid: 'a1', sender: 'human', index: 2, text: 'thanks' },
    { uuid: 'a2', parent_message_uuid: 'h2', sender: 'assistant', index: 3, content: [{ type: 'text', text: 'welcome' }] },
  ],
};

describe('collectMedia', () => {
  it('gathers re-linkable file_uuids, re-attachable documents, and sync sources up to the anchor', () => {
    const m = collectMedia(tree, 'a2');
    expect(m.files).toEqual(['IMG1']);
    expect(m.attachments).toEqual([
      { file_name: 'doc.txt', file_type: 'txt', file_size: 10, extracted_content: 'hello doc' },
    ]);
    expect(m.sync_sources).toEqual([]);
  });

  it('dedupes a file_uuid that appears on multiple messages', () => {
    const dup: ConversationTree = JSON.parse(JSON.stringify(tree));
    dup.chat_messages[3].files = [{ file_uuid: 'IMG1', file_name: 'a.png' }];
    expect(collectMedia(dup, 'a2').files).toEqual(['IMG1']);
  });

  it('only collects media on the path up to the anchor', () => {
    // anchored at a1: h2/a2 are after it, but h1's media is before → included; nothing extra
    expect(collectMedia(tree, 'a1').files).toEqual(['IMG1']);
  });
});

describe('buildSeed media handling', () => {
  const seed = buildSeed({ tree, anchorMessageUuid: 'a2', highlight: 'a file', question: 'why?' });

  it('embeds generated artifact/file content as text', () => {
    expect(seed).toContain('[File: app.js]');
    expect(seed).toContain('console.log(1)');
  });

  it('does NOT inline document text or image notes (those ride the native arrays)', () => {
    expect(seed).not.toContain('hello doc');
    expect(seed).not.toContain('Attached image');
  });
});
