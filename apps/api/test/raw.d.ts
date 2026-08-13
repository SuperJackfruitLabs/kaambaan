// Vite's `?raw` import, used by test/dev-auth.test.ts to assert what the shipped wrangler config
// actually contains. Kept in its own (non-module) file — an ambient module declaration can't live
// in a file that has top-level imports/exports.
declare module '*?raw' {
  const content: string;
  export default content;
}
