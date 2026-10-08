// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://docs.superpipeline.dev',
  integrations: [
    starlight({
      title: 'superpipeline',
      description:
        'A kanban board where agents do the work and a human approves it. Docs for operating a board and for building agents that work one.',
      // /llms.txt, /llms-full.txt and /llms-small.txt, for agents reading these docs. The
      // full file carries every page, reference pages included; the small one drops asides
      // and <details> but keeps every page too, since nothing here is noise.
      plugins: [
        starlightLlmsTxt({
          projectName: 'superpipeline',
          description:
            'superpipeline is a kanban board where agents do the work and a human approves it. A ' +
            'column can be owned by a capability rather than a person, and any agent holding that ' +
            'capability can claim a card sitting in it. A stage can carry an approval gate, where a ' +
            'card stops until somebody decides, and a stage can state what it must see before it ' +
            'believes a run finished; a completion that does not produce it parks the card on a ' +
            'person instead of advancing it. superpipeline stands alone as a board for your own ' +
            'agents and can optionally be linked to an AgentPod fleet. Agents work a board through ' +
            'the supi CLI or the MCP tools, both documented in full in the reference pages.',
          optionalLinks: [
            { label: 'superpipeline', url: 'https://superpipeline.dev', description: 'The product site.' },
            { label: 'Source', url: 'https://github.com/SuperJackfruitLabs/superpipeline', description: 'The superpipeline repository on GitHub.' },
          ],
        }),
      ],
      // The mark and palette are the app's; see src/styles/theme.css for where each value
      // comes from.
      logo: { src: './src/assets/mark.svg', alt: '' },
      customCss: ['./src/styles/theme.css'],
      favicon: '/favicon.svg',
      head: [
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: true } },
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href:
              'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700' +
              '&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap',
          },
        },
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://superpipeline.dev/og.png' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:image', content: 'https://superpipeline.dev/og.png' } },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/SuperJackfruitLabs/superpipeline' },
      ],
      // Four sections, in the order a reader needs them. See
      // docs/superpowers/specs/2026-09-12-publishing-user-docs-design.md.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'What superpipeline is', slug: 'start/what-it-is' },
            { label: 'Your first board', slug: 'start/first-board' },
            { label: 'Concepts', slug: 'start/concepts' },
            { label: 'Install on your phone', slug: 'start/install-on-your-phone' },
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Boards and pipelines', slug: 'use/boards' },
            { label: 'Cards and their states', slug: 'use/cards' },
            { label: 'Comments on a card', slug: 'use/comments' },
            { label: 'Planning work', slug: 'use/planning' },
            { label: 'Recurring cards', slug: 'use/recurring' },
            { label: 'Stage runbooks and completion', slug: 'use/runbooks' },
            { label: 'Agents and capabilities', slug: 'use/agents' },
            { label: 'Registering an agent', slug: 'use/register-an-agent' },
            { label: 'Agents that plan', slug: 'use/autonomy' },
            { label: 'Approval gates', slug: 'use/gates' },
            { label: 'People and roles', slug: 'use/people' },
            { label: 'From the terminal', slug: 'use/cli' },
          ],
        },
        {
          label: 'Build on it',
          items: [
            { label: 'Writing an agent', slug: 'build/agent-contract' },
            { label: 'MCP tools', slug: 'build/mcp' },
            { label: 'Authentication', slug: 'build/auth' },
          ],
        },
        // Generated pages: `reference/cli/*` from packages/cli/src/commands.ts, `reference/mcp-tools`
        // from the MCP server's registrations. Both are guarded in CI — see each generator.
        {
          label: 'Reference',
          items: [
            { label: 'supi CLI', items: [{ autogenerate: { directory: 'reference/cli' } }] },
            { label: 'MCP tools', slug: 'reference/mcp-tools' },
          ],
        },
      ],
    }),
  ],
});
