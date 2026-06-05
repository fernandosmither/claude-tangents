/**
 * Every claude.ai-internal DOM selector the extension depends on, in one place.
 *
 * These are the *only* things that break when claude.ai changes its markup. If the
 * extension stops working after a claude.ai update, the fix almost always lives here.
 * Each entry lists a couple of fallbacks (older builds / alternates) where it helps.
 */
export const SEL = {
  /** A Claude (assistant) answer container. */
  assistantMessage: '.font-claude-response, .font-claude-message',
  /** A paragraph inside an assistant answer (used to locate selections). */
  assistantParagraph: 'p.font-claude-response-body, .font-claude-response p',
  /** A user message bubble (the seed message we hide inside the tangent iframe). */
  userMessage: '[data-testid="user-message"]',
  userBubble: '[data-user-message-bubble]',
  /** The message composer (used to detect a loaded conversation). */
  composer: '[data-testid="chat-input"]',
  /** claude.ai's top conversation header (stripped in the tangent iframe). */
  pageHeader: '[data-testid="page-header"]',
  /** The left sidebar (stripped in the tangent iframe). */
  sidebar: 'nav',
  /** A candidate for claude.ai's floating text-selection toolbar (the dark pill with "Reply"). */
  selectionToolbar: 'div[class*="bg-always-black"]',
} as const;

/** Find claude.ai's floating selection toolbar (the dark pill that holds "Reply"). */
export function findSelectionToolbar(): HTMLElement | null {
  for (const d of document.querySelectorAll<HTMLElement>(SEL.selectionToolbar)) {
    const c = d.className.toString();
    if (c.includes('shadow-lg') && d.querySelector('button')) return d;
  }
  return null;
}
