import type { ChatMessage, ConversationTree, Organization } from './types';
import { ROOT_PARENT, uuidv7 } from './uuid';

/**
 * Thin client over claude.ai's internal API. All calls are same-origin and run
 * from the claude.ai page (content script), so the session cookie is sent.
 *
 * A tangent conversation is created with two tiny, drift-resistant calls
 * (verified live): `createConversation` then `sendCompletion` with a *minimal*
 * payload. The conversation is then rendered by an iframe of `/chat/{uuid}`, so
 * we never re-implement claude.ai's full completion payload or its rendering.
 */

const ORG_KEY = 'tangent.chatOrgUuid';

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`https://claude.ai/api${path}`, {
    credentials: 'include',
    headers: { accept: 'application/json', ...(init?.headers || {}) },
    ...init,
  });
}

/** Find the organization whose capabilities include `chat` (cached in sessionStorage). */
export async function getChatOrgUuid(): Promise<string> {
  const cached = sessionStorage.getItem(ORG_KEY);
  if (cached) return cached;
  const res = await api('/organizations');
  if (!res.ok) throw new Error(`organizations ${res.status}`);
  const orgs: Organization[] = await res.json();
  const chat = orgs.find((o) => o.capabilities?.includes('chat'));
  if (!chat) throw new Error('No organization with chat capability');
  sessionStorage.setItem(ORG_KEY, chat.uuid);
  return chat.uuid;
}

export async function getTree(convUuid: string, org?: string): Promise<ConversationTree> {
  const o = org || (await getChatOrgUuid());
  const res = await api(
    `/organizations/${o}/chat_conversations/${convUuid}?tree=True&rendering_mode=messages&render_all_tools=true`,
  );
  if (!res.ok) throw new Error(`getTree ${res.status}`);
  return res.json();
}

/** Plain visible text of a message (joins `text` content blocks; ignores thinking/tool blocks). */
export function messageText(m: ChatMessage): string {
  if (typeof m.text === 'string' && m.text) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Walk the message tree from root to `leafUuid`, returning messages in order.
 * If `leafUuid` is omitted, follows `current_leaf_message_uuid`.
 */
export function pathTo(tree: ConversationTree, leafUuid?: string): ChatMessage[] {
  const byUuid = new Map(tree.chat_messages.map((m) => [m.uuid, m]));
  const target = leafUuid || tree.current_leaf_message_uuid;
  if (!target || !byUuid.has(target)) {
    // fall back to index order
    return [...tree.chat_messages].sort((a, b) => a.index - b.index);
  }
  const chain: ChatMessage[] = [];
  let cur: ChatMessage | undefined = byUuid.get(target);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.uuid)) {
    seen.add(cur.uuid);
    chain.push(cur);
    cur = byUuid.get(cur.parent_message_uuid);
  }
  return chain.reverse();
}

/** Create an empty conversation with a client-chosen UUID. Returns the conversation UUID. */
export async function createConversation(name: string, org?: string): Promise<string> {
  const o = org || (await getChatOrgUuid());
  const uuid = crypto.randomUUID();
  const res = await api(`/organizations/${o}/chat_conversations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uuid, name }),
  });
  if (!res.ok && res.status !== 201) throw new Error(`createConversation ${res.status}`);
  return uuid;
}

export interface CompletionOpts {
  convUuid: string;
  prompt: string;
  model: string;
  parentUuid?: string; // defaults to ROOT (new top-level message)
  org?: string;
  signal?: AbortSignal;
}

/**
 * Send a message and start generation. Minimal payload (verified live): adding
 * `tools`/styles/effort/thinking is unnecessary. Returns the streaming Response;
 * the caller may ignore/drain it (the iframe renders the result).
 */
export async function sendCompletion(opts: CompletionOpts): Promise<Response> {
  const o = opts.org || (await getChatOrgUuid());
  const body = {
    prompt: opts.prompt,
    parent_message_uuid: opts.parentUuid || ROOT_PARENT,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: opts.model,
    rendering_mode: 'messages',
    turn_message_uuids: {
      human_message_uuid: uuidv7(),
      assistant_message_uuid: uuidv7(),
    },
  };
  return api(`/organizations/${o}/chat_conversations/${opts.convUuid}/completion`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

/** Drain a streaming completion Response to completion (we don't need to parse it). */
export async function drain(res: Response): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

export async function deleteConversation(convUuid: string, org?: string): Promise<boolean> {
  const o = org || (await getChatOrgUuid());
  const res = await api(`/organizations/${o}/chat_conversations/${convUuid}`, { method: 'DELETE' });
  return res.status === 204 || res.ok;
}

/**
 * Hide a tangent conversation from the sidebar.
 * The exact archive endpoint is confirmed at build time (see plan task #7); this
 * tries the known candidates and reports which worked.
 */
export async function archiveConversation(convUuid: string, org?: string): Promise<boolean> {
  const o = org || (await getChatOrgUuid());
  const candidates: Array<() => Promise<Response>> = [
    () =>
      api(`/organizations/${o}/chat_conversations/${convUuid}?rendering_mode=raw`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ is_archived: true }),
      }),
    () =>
      api(`/organizations/${o}/chat_conversations/${convUuid}/archive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
  ];
  for (const attempt of candidates) {
    try {
      const res = await attempt();
      if (res.ok) return true;
    } catch {
      /* try next */
    }
  }
  return false;
}
