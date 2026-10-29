// Where Electronic Trade Document data lives, and how ETD settings are read.
// Read from the running server's environment first: Astro bakes import.meta.env
// values in at build time, so a variable set only on the server would otherwise
// be ignored.

import path from 'node:path';

export const etdEnv = (name: 'ETD_DIR' | 'ETD_SIGNING_KEY' | 'ETD_DEFAULT_LIMIT'): string | undefined =>
  process.env[name] || import.meta.env[name] || undefined;

export const root = () => path.resolve(etdEnv('ETD_DIR') ?? 'data/etd');
