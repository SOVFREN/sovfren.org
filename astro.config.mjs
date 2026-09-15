import { defineConfig } from 'astro/config';
import node from '@astrojs/node';

// SSR is required: Register and Property lookups resolve a serial/id against
// the SovfHub API at request time, they aren't known at build time.
export default defineConfig({
  site: 'https://sovfren.org',
  output: 'server',
  adapter: node({ mode: 'standalone' }),
});
