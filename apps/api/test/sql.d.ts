/** Vite serves `?raw` imports as the file's text — used to run real migration SQL in tests. */
declare module '*.sql?raw' {
  const contents: string;
  export default contents;
}
