// Map file extensions / basenames to Monaco language IDs.
// Monaco's built-in languages: https://github.com/microsoft/monaco-editor/tree/main/src/basic-languages
const BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  md: "markdown",
  mdx: "markdown",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "dockerfile",
  env: "ini",
  txt: "plaintext",
  log: "plaintext",
};

const BY_BASENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  ".gitignore": "ignore",
  ".dockerignore": "ignore",
  "tsconfig.json": "json",
  "package.json": "json",
  "package-lock.json": "json",
};

export function detectLanguage(relPath: string): string {
  const base = relPath.split("/").pop()?.toLowerCase() ?? "";
  if (BY_BASENAME[base]) return BY_BASENAME[base];
  const ext = base.includes(".") ? base.split(".").pop()! : base;
  return BY_EXT[ext] ?? "plaintext";
}
