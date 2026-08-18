/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_NEXUS_ENV?: string;
  readonly VITE_NEXUS_VERSION?: string;
  readonly VITE_NEXUS_BUILD?: string;
  readonly VITE_NEXUS_DB_NAME?: string;
  readonly VITE_NEXUS_SESSION_TTL_MS?: string;
  readonly VITE_NEXUS_PBKDF2_ITERATIONS?: string;
  readonly VITE_NEXUS_MAX_REQUEST_CHARS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
