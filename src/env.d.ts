/// <reference types="vite/client" />

// Monaco without its language services: editor core + syntax highlighting only
declare module "monaco-editor/esm/vs/editor/edcore.main" {
  export * from "monaco-editor";
}
declare module "monaco-editor/esm/vs/basic-languages/monaco.contribution";
declare module "monaco-editor/esm/vs/basic-languages/cpp/cpp.js" {
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}
