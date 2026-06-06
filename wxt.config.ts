import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'Tangent',
    description:
      'Select any text in a Claude answer and open a forked side-conversation in a floating popover — without muddying your main chat.',
    permissions: ['storage'],
    host_permissions: ['https://claude.ai/*'],
    // Firefox-only: a stable add-on id, a minimum version that supports the CSS Custom Highlight
    // API (used for the inline anchors), and the data-collection declaration AMO now requires —
    // Tangent collects no data (local storage + claude.ai's own session only).
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'tangent@fdosmith.dev',
              strict_min_version: '117.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
