import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'Tangent',
    description:
      'Select any text in a Claude answer and open a forked side-conversation in a floating popover — without muddying your main chat.',
    permissions: ['storage'],
    host_permissions: ['https://claude.ai/*'],
  },
});
