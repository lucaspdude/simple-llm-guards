// Canonical vocabulary: five harnesses, five spellings of the same tools.
//
// Every harness names its tools and its arguments differently. Rules are written
// once against the canonical names (`shell`, `file_path`, `command`) and this
// module translates a native tool call into that vocabulary. That translation is
// the only harness-specific code the engine needs.

/** @typedef {'shell'|'read'|'write'|'edit'|'fetch'|'search'|'mcp'|'other'} CanonicalTool */

export const HARNESSES = ['pi', 'omp', 'claude', 'copilot', 'gemini', 'agy'];

const TOOL_ALIASES = {
  // pi and omp expose the identical `tool_call` extension API.
  pi: {
    bash: 'shell', shell: 'shell', powershell: 'shell',
    read: 'read', view: 'read',
    write: 'write', create: 'write',
    edit: 'edit', str_replace_editor: 'edit',
    web_fetch: 'fetch', web_search: 'search',
  },
  claude: {
    Bash: 'shell', shell: 'shell', PowerShell: 'shell',
    Read: 'read', view: 'read',
    Write: 'write', create: 'write',
    Edit: 'edit', MultiEdit: 'edit',
    WebFetch: 'fetch', WebSearch: 'search',
  },
  copilot: {
    bash: 'shell', shell: 'shell',
    view: 'read',
    create: 'write',
    edit: 'edit', str_replace_editor: 'edit', apply_patch: 'edit',
    web_fetch: 'fetch', web_search: 'search',
  },
  gemini: {
    run_shell_command: 'shell', shell: 'shell',
    read_file: 'read',
    write_file: 'write',
    replace: 'edit', replace_file_content: 'edit', edit: 'edit',
    google_web_search: 'search', web_fetch: 'fetch',
  },
  agy: {
    run_command: 'shell', shell: 'shell',
    view_file: 'read',
    write_to_file: 'write',
    replace_file_content: 'edit', multi_replace_file_content: 'edit',
    search_web: 'search', read_url_content: 'fetch',
  },
};
TOOL_ALIASES.omp = TOOL_ALIASES.pi;

// Canonical argument names per canonical tool. Native keys are preserved too, so
// a rule can still target a harness-specific argument by its original name.
const ARG_ALIASES = {
  shell: { command: 'command', CommandLine: 'command', cmd: 'command' },
  read: { path: 'file_path', file_path: 'file_path', absolute_path: 'file_path', AbsolutePath: 'file_path', filePath: 'file_path' },
  write: { path: 'file_path', file_path: 'file_path', TargetFile: 'file_path', targetFile: 'file_path', filePath: 'file_path' },
  edit: { path: 'file_path', file_path: 'file_path', TargetFile: 'file_path', targetFile: 'file_path', filePath: 'file_path' },
};

function toolTable(harness) {
  return TOOL_ALIASES[harness] ?? TOOL_ALIASES.pi;
}

/** Translate a native tool name into the canonical vocabulary. */
export function canonicalTool(harness, toolName) {
  const name = String(toolName ?? '');
  const table = toolTable(harness);
  if (table[name]) return table[name];
  // Case-insensitive second chance: `Bash`, `bash`, `BASH`.
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (key.toLowerCase() === lower) return value;
  }
  if (name.startsWith('mcp_')) return 'mcp';
  return 'other';
}

/**
 * Copy `args` and add canonical aliases for the keys that exist.
 * Never mutates the input: harnesses reuse the object after the hook returns.
 */
export function canonicalArgs(harness, toolName, args) {
  const source = args && typeof args === 'object' ? args : {};
  const canonical = canonicalTool(harness, toolName);
  const table = ARG_ALIASES[canonical] ?? {};
  const out = { ...source };
  for (const [native, canonicalKey] of Object.entries(table)) {
    if (out[canonicalKey] === undefined && typeof source[native] === 'string') {
      out[canonicalKey] = source[native];
    }
  }
  return out;
}

/** Build the one request shape the engine understands. */
export function normalize({ harness, tool, args, cwd, sessionId }) {
  return {
    harness,
    rawTool: String(tool ?? ''),
    tool: canonicalTool(harness, tool),
    args: canonicalArgs(harness, tool, args),
    cwd: cwd ?? process.cwd(),
    sessionId: sessionId ?? null,
  };
}