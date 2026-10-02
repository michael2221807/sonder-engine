/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Unset, empty or on/true/1/yes (any case) builds the app with plot momentum available (P5 release gate); 'off' or any other value closes it. */
  readonly VITE_PLOT_VECTOR_RELEASE?: string;
}

/** Allow importing .vue files in TypeScript */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
