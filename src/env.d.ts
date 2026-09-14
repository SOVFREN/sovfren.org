/// <reference path="../.astro/types.d.ts" />
/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly SOVFHUB_API_URL: string;
  readonly SOVFHUB_API_KEY: string;
  readonly SSO_CLIENT_ID: string;
  readonly SSO_CLIENT_SECRET: string;
  readonly SSO_AUTHORIZE_URL: string;
  readonly SSO_TOKEN_URL: string;
  readonly SSO_USERINFO_URL: string;
  readonly SSO_REDIRECT_URI: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
