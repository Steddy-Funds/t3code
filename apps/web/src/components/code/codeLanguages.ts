import type { CodeLibraryRoot, CodeServerStatus } from "@t3tools/contracts";

// The server's language registry, for picking the status row a file belongs to. Requests do not
// need it: the server answers `unsupported_language` for anything else.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  pyi: "python",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",
  js: "typescript",
  mjs: "typescript",
  cjs: "typescript",
  jsx: "typescript",
};

export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function codeLanguageForPath(path: string): string | null {
  return LANGUAGE_BY_EXTENSION[fileExtension(path)] ?? null;
}

export function serverForPath(
  servers: ReadonlyArray<CodeServerStatus>,
  path: string,
): CodeServerStatus | null {
  const languageId = codeLanguageForPath(path);
  return languageId === null
    ? null
    : (servers.find((server) => server.languageId === languageId) ?? null);
}

function isWithin(path: string, root: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** The library root an absolute path lies under, innermost first when roots nest. */
export function libraryRootForPath(
  servers: ReadonlyArray<CodeServerStatus>,
  absolutePath: string,
): CodeLibraryRoot | null {
  let match: CodeLibraryRoot | null = null;
  for (const server of servers) {
    for (const root of server.libraryRoots) {
      if (!isWithin(absolutePath, root.path)) continue;
      if (match === null || root.path.length > match.path.length) match = root;
    }
  }
  return match;
}
