import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  output: 'server',
  session: false,
  vite: {
    ssr: {
      external: ['node:buffer'],
    },
  },
});