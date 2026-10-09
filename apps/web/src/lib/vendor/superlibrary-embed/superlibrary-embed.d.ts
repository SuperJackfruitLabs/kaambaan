/**
 * The public types of `@superlibrary/embed` for hosts that vendor `superlibrary-embed.js`.
 * Hand-kept; `test/bundle-types.ts` fails the typecheck when they differ from the source.
 */
export type Theme = 'light' | 'dark' | 'system';
export type Scope = 'workspace' | `board:${string}`;
export type View =
  | 'html' | 'markdown' | 'image' | 'svg' | 'pdf' | 'code' | 'text' | 'json' | 'yaml' | 'toml'
  | 'csv' | 'tsv' | 'ipynb' | 'mermaid' | 'graphviz' | 'audio' | 'video' | 'download';
export interface FileEntry { path: string; mediaType: string; view: View; bytes: number }
export interface EmbedGrant {
  url: string;
  downloadUrl: string | null;
  expiresAt: string;
  version: number;
  itemUrl: string;
  entry: string;
  files: FileEntry[];
}
export interface ShareInfo { scope: Scope; boardVisible?: boolean; canWiden: boolean; title?: string }
export interface MountOptions {
  itemId: string;
  version?: number;
  getEmbedUrl: (q: { itemId: string; version?: number }) => Promise<EmbedGrant>;
  appUrl?: string;
  height?: number;
  clipboard?: Pick<Clipboard, 'writeText'>;
  getVersions?: (q: { itemId: string }) => Promise<number[]>;
  getShareInfo?: (q: { itemId: string }) => Promise<ShareInfo>;
  setScope?: (q: { itemId: string; scope: 'workspace' }) => Promise<unknown>;
  title?: string;
  theme?: Theme;
  onVersionChange?: (version: number) => void;
  onScopeChange?: (info: ShareInfo) => void;
  nonce?: string;
}
export interface Mounted {
  iframe: HTMLIFrameElement;
  setTheme(theme: Theme): void;
  setVersion(version: number): Promise<boolean>;
  destroy(): void;
}
export declare const SANDBOX: string;
export declare function mountArtifact(el: HTMLElement, opts: MountOptions): Promise<Mounted>;
export declare function formatBytes(n: number): string;
export declare function visibilityWords(info: ShareInfo): string;
