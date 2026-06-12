// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://mabulu-inc.github.io',
  base: '/simplicity-auth',
  integrations: [
    starlight({
      title: '@smplcty/auth',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/mabulu-inc/simplicity-auth',
        },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', slug: 'getting-started/introduction' },
            { label: 'Installation', slug: 'getting-started/installation' },
            { label: 'Quick start', slug: 'getting-started/quick-start' },
          ],
        },
        {
          label: 'Sessions',
          items: [
            { label: 'withSession', slug: 'sessions/with-session' },
            { label: 'Authorization scope', slug: 'sessions/scope' },
            { label: 'Session lifecycle', slug: 'sessions/lifecycle' },
            { label: 'Background work', slug: 'sessions/background' },
          ],
        },
        {
          label: 'Sign-in methods',
          items: [
            { label: 'Overview', slug: 'methods/overview' },
            { label: 'OIDC', slug: 'methods/oidc' },
            { label: 'Developer OTP', slug: 'methods/dev-otp' },
          ],
        },
        {
          label: 'Schema',
          items: [{ label: 'Required database schema', slug: 'schema/overview' }],
        },
        {
          label: 'Reference',
          items: [{ label: 'Identity GUC contract', slug: 'reference/identity-gucs' }],
        },
        {
          label: 'Security',
          items: [{ label: 'Security model', slug: 'security' }],
        },
        {
          label: 'Design',
          items: [
            { label: 'v1 design', slug: 'design/v1' },
            { label: 'ADR-0001 — OIDC', slug: 'design/adr-0001' },
          ],
        },
      ],
    }),
  ],
});
