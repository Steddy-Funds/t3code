import type { PythonEnvironmentLocation } from "./PythonEnvironment.ts";

const GiB = 1024 ** 3;

export interface LanguageContext {
  /** The workspace root, symlinks resolved. */
  readonly root: string;
  /** Python only: the environment found by reading files. */
  readonly python?: PythonEnvironmentLocation | undefined;
}

/** One language server. Adding a language is a row here and a row in `LanguageServerBinaries`. */
export interface LanguageRow {
  readonly id: string;
  /** Lowercase file extension to the `languageId` LSP's `didOpen` carries. */
  readonly extensions: Readonly<Record<string, string>>;
  /** The ceiling of the server's own scope on Linux; a kill above it never touches an agent. */
  readonly memoryMaxBytes: number;
  /** The runtime's own heap cap, where it has one: the only limit off Linux. */
  readonly environment: Readonly<Record<string, string>>;
  readonly initializationOptions: (context: LanguageContext) => unknown;
  /** Answers one `workspace/configuration` item. `null` keeps the server's default. */
  readonly configuration: (section: string | undefined, context: LanguageContext) => unknown;
  /** A changed file the server is told about. */
  readonly watches: (fileName: string) => boolean;
  /** A changed file that means third-party code moved: the server restarts. */
  readonly restartsOn: (fileName: string) => boolean;
}

const hasExtension = (fileName: string, extensions: ReadonlyArray<string>) =>
  extensions.some((extension) => fileName.endsWith(extension));

const tyOptions = (context: LanguageContext) => ({
  // Diagnostics are a different feature with a constant cost; navigation does not need them.
  diagnosticMode: "off",
  ...(context.python?.environment === undefined
    ? {}
    : { configuration: { environment: { python: context.python.environment } } }),
});

const python: LanguageRow = {
  id: "python",
  extensions: { ".py": "python", ".pyi": "python" },
  memoryMaxBytes: 2 * GiB,
  // ty is Rust: it has no heap flag, so only the Linux scope bounds it.
  environment: {},
  initializationOptions: tyOptions,
  configuration: (section, context) => (section === "ty" ? tyOptions(context) : null),
  watches: (fileName) =>
    hasExtension(fileName, [".py", ".pyi"]) || fileName === "pyproject.toml" || fileName === "ty.toml",
  restartsOn: (fileName) =>
    fileName === "pyvenv.cfg" ||
    fileName === "uv.lock" ||
    fileName === "pyproject.toml" ||
    fileName === "pyrightconfig.json" ||
    /^requirements.*\.txt$/.test(fileName),
};

// Type acquisition installs packages from npm; both switches are answered because an
// unanswered section keeps the default, which is on.
const TYPE_ACQUISITION_OFF = {
  "js/ts": { tsserver: { automaticTypeAcquisition: { enabled: false } } },
  typescript: { disableAutomaticTypeAcquisition: true },
  javascript: { disableAutomaticTypeAcquisition: true },
} as const;

const typescript: LanguageRow = {
  id: "typescript",
  extensions: {
    ".ts": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascriptreact",
  },
  memoryMaxBytes: 4 * GiB,
  // tsc is Go: a soft limit the collector works to stay under.
  environment: { GOMEMLIMIT: String(3 * GiB) },
  initializationOptions: () => ({}),
  configuration: (section) =>
    section !== undefined && Object.hasOwn(TYPE_ACQUISITION_OFF, section)
      ? TYPE_ACQUISITION_OFF[section as keyof typeof TYPE_ACQUISITION_OFF]
      : null,
  watches: (fileName) =>
    hasExtension(fileName, [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".json"]),
  restartsOn: (fileName) =>
    fileName === "package.json" ||
    fileName === "pnpm-lock.yaml" ||
    fileName === "package-lock.json" ||
    fileName === "yarn.lock" ||
    fileName === "jsconfig.json" ||
    /^tsconfig.*\.json$/.test(fileName),
};

export const LANGUAGE_ROWS: ReadonlyArray<LanguageRow> = [python, typescript];

export const languageRow = (languageId: string): LanguageRow | undefined =>
  LANGUAGE_ROWS.find((row) => row.id === languageId);

/** The row that serves a file, and the `languageId` its `didOpen` carries. */
export function languageForPath(
  filePath: string,
): { readonly row: LanguageRow; readonly documentLanguageId: string } | undefined {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return undefined;
  const extension = filePath.slice(dot).toLowerCase();
  for (const row of LANGUAGE_ROWS) {
    const documentLanguageId = Object.hasOwn(row.extensions, extension)
      ? row.extensions[extension]
      : undefined;
    if (documentLanguageId !== undefined) return { row, documentLanguageId };
  }
  return undefined;
}
