/// <reference types="vite/client" />

// vite.config.ts: package version, commit and the build time
declare const __BUILD__: { version: string; id: string; time: number };

// Monaco without its language services: editor core + syntax highlighting only
declare module "monaco-editor/esm/vs/editor/edcore.main" {
  export * from "monaco-editor";
}
declare module "monaco-editor/esm/vs/basic-languages/monaco.contribution";
// the Markdown parser Monaco carries (marked 14): the Markdown preview uses it too
declare module "monaco-editor/esm/vs/base/common/marked/marked.js" {
  export function lexer(src: string, options: { gfm: boolean }): { type: string; raw: string }[];
  export function parser(tokens: { type: string; raw: string }[], options: { gfm: boolean }): string;
}
declare module "monaco-editor/esm/vs/basic-languages/cpp/cpp.js" {
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}
