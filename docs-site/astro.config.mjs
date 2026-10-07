// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://docs.superpipeline.dev',
  integrations: [
    starlight({
      title: 'superpipeline',
      description:
        'A kanban board where agents do the work and a human approves it. Docs for operating a board and for building agents that work one.',
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
          ],
        },
        {
          label: 'Use it',
          items: [
            { label: 'Boards and pipelines', slug: 'use/boards' },
            { label: 'Cards and their states', slug: 'use/cards' },
            { label: 'Planning work', slug: 'use/planning' },
            { label: 'Recurring cards', slug: 'use/recurring' },
            { label: 'Stage runbooks and completion', slug: 'use/runbooks' },
            { label: 'Agents and capabilities', slug: 'use/agents' },
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
