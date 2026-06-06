// Shapes reverse-engineered from claude.ai's internal API (see plan / README).

export interface AttachmentDoc {
  file_name: string;
  extracted_content: string;
  file_type?: string;
  file_size?: number;
}

export interface FileRef {
  file_uuid: string;
  file_name?: string;
  [k: string]: unknown;
}

export interface ContentBlock {
  type: string; // 'text' | 'thinking' | 'tool_use' | ...
  text?: string;
  [k: string]: unknown;
}

export interface ChatMessage {
  uuid: string;
  parent_message_uuid: string;
  sender: 'human' | 'assistant';
  index: number;
  text?: string;
  content?: ContentBlock[];
  model?: string;
  attachments?: AttachmentDoc[];
  files?: FileRef[];
  files_v2?: FileRef[];
  sync_sources?: unknown[];
}

export interface ConversationSettings {
  effort_level?: string;
  thinking_mode?: string;
  enabled_web_search?: boolean;
  paprika_mode?: string | null;
  [k: string]: unknown;
}

export interface ConversationTree {
  uuid: string;
  name?: string;
  model?: string | null;
  settings?: ConversationSettings;
  current_leaf_message_uuid?: string;
  chat_messages: ChatMessage[];
}

export interface Organization {
  uuid: string;
  name: string;
  capabilities: string[];
}

/** A persisted tangent: a separate (archived) claude.ai conversation anchored to a highlight. */
export interface TangentRecord {
  tangentId: string; // local id
  mainConvUuid: string; // the conversation the highlight lives in
  anchorMessageUuid: string; // the assistant message the highlight is inside
  highlightText: string; // the selected text
  prefix: string; // a little context before, to re-locate the highlight
  suffix: string; // a little context after
  tangentConvUuid: string; // the separate claude.ai conversation backing this tangent
  title: string;
  createdAt: number;
}
