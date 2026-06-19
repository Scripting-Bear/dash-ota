import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

const GITHUB = 'https://github.com/Scripting-Bear/dash-ota';

const config: Config = {
  title: 'dash-ota',
  tagline: 'Self-hosted, security-hardened over-the-air updates for React Native',
  favicon: 'img/dash-logo.svg',

  url: 'https://scripting-bear.github.io',
  baseUrl: '/dash-ota/',
  organizationName: 'Scripting-Bear',
  projectName: 'dash-ota',
  trailingSlash: false,

  onBrokenLinks: 'throw',
  onBrokenMarkdownLinks: 'warn',

  future: { v4: true },

  i18n: { defaultLocale: 'en', locales: ['en'] },

  markdown: { mermaid: true },
  themes: [
    '@docusaurus/theme-mermaid',
    [
      // local, offline search — no Algolia account needed
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        hashed: true,
        indexBlog: false,
        docsRouteBasePath: '/docs',
        highlightSearchTermsOnTargetPage: true,
        explicitSearchResultPath: true,
      },
    ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: `${GITHUB}/tree/main/website/`,
          showLastUpdateTime: true,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    image: 'img/logo.svg',
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    mermaid: { theme: { light: 'neutral', dark: 'dark' } },
    docs: { sidebar: { hideable: true, autoCollapseCategories: true } },
    navbar: {
      title: 'dash-ota',
      logo: { alt: 'dash-ota', src: 'img/dash-logo.svg', width: 30, height: 30 },
      hideOnScroll: true,
      items: [
        { type: 'docSidebar', sidebarId: 'docs', position: 'left', label: 'Docs' },
        { to: '/docs/getting-started/quickstart', position: 'left', label: 'Quickstart' },
        { to: '/docs/guides/migrate-from-stallion', position: 'left', label: 'Guides' },
        { to: '/docs/introduction/comparison', position: 'left', label: 'Compare' },
        { to: '/docs/api/react-native', position: 'left', label: 'API' },
        { href: 'https://www.npmjs.com/org/dash-ota', position: 'right', label: 'npm' },
        { href: GITHUB, position: 'right', className: 'navbar-github', 'aria-label': 'GitHub' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Introduction', to: '/docs/' },
            { label: 'Quickstart', to: '/docs/getting-started/quickstart' },
            { label: 'React Native', to: '/docs/react-native/installation' },
            { label: 'Backend', to: '/docs/backend/installation' },
            { label: 'CLI', to: '/docs/cli/overview' },
          ],
        },
        {
          title: 'Reference',
          items: [
            { label: 'Security model', to: '/docs/concepts/security-model' },
            { label: 'Versioning & targeting', to: '/docs/concepts/versioning-targeting' },
            { label: 'API reference', to: '/docs/api/react-native' },
            { label: 'FAQ', to: '/docs/faq' },
          ],
        },
        {
          title: 'Packages',
          items: [
            { label: 'react-native-dash-ota', href: 'https://www.npmjs.com/package/react-native-dash-ota' },
            { label: '@dash-ota/backend', href: 'https://www.npmjs.com/package/@dash-ota/backend' },
            { label: '@dash-ota/cli', href: 'https://www.npmjs.com/package/@dash-ota/cli' },
            { label: '@dash-ota/shared', href: 'https://www.npmjs.com/package/@dash-ota/shared' },
          ],
        },
        {
          title: 'More',
          items: [
            { label: 'GitHub', href: GITHUB },
            { label: 'Compare alternatives', to: '/docs/introduction/comparison' },
            { label: 'Roadmap', to: '/docs/contributing/roadmap' },
          ],
        },
      ],
      copyright: `dash-ota — MIT licensed · Built by <a href="https://github.com/Priyanshu-Agrawal" target="_blank" rel="noopener">Priyanshu&nbsp;Agrawal</a> 🐻 <a href="https://github.com/Scripting-Bear" target="_blank" rel="noopener">Scripting&nbsp;Bear</a>`,
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'json', 'kotlin', 'swift', 'groovy', 'ruby', 'diff', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
