# simple-llm-guards

**One guard engine. Six harnesses. One rules file.**

Every coding-agent harness now has a way to stop a tool call *before* it runs.
None of them agree on how. This project puts the decision in one place and lets
each harness keep its own dialect.

```
                     guards.jsonc            ← you write this, once
                          │
             ┌────────────┴────────────┐
             │   engine.js (pure)      │     evaluate() → allow | deny
             └────────────┬────────────┘
        ┌────────┬────────┼────────┬─────────┐
      pi/omp   claude    copilot   gemini     agy     ← each speaks its own protocol
```

| harness | event | how it blocks | config written by `guards install` |
|---|---|---|---|
| **pi** | `tool_call` | in-process: `return { block: true, reason }` | `~/.pi/agent/extensions/simple-llm-guards.js` |
| **omp** | `tool_call` | same in-process API as pi | `~/.omp/agent/extensions/simple-llm-guards.ts` |
| **Claude Code** | `PreToolUse` | stdout JSON with `permissionDecision: "deny"` | `~/.claude/settings.json` → `hooks.PreToolUse` |
| **Copilot CLI** | `preToolUse` | stdout JSON with `permissionDecision: "deny"` | `~/.copilot/hooks/simple-llm-guards.json` |
| **Gemini CLI** | `BeforeTool` | stdout JSON with `decision: "deny"` | `~/.gemini/settings.json` → `hooks.BeforeTool` |
| **Antigravity CLI (`agy`)** | `PreToolUse` | stdout JSON with `decision: "deny"` | `~/.gemini/config/hooks.json` |

Sources: [Claude Code hooks](https://code.claude.com/docs/en/hooks) ·
[Copilot hooks reference](https://docs.github.com/en/copilot/reference/hooks-reference) ·
[Gemini CLI hooks reference](https://geminicli.com/docs/hooks/reference/) ·
[Antigravity hooks](https://antigravity.google/docs/hooks/) · pi extension API (`pi.on("tool_call")`).

## Install

```bash
npx simple-llm-guards      # no arguments: detect, pick, install
```

That is the whole install. It copies the runtime to a stable path, shows you the
harnesses it found pre-checked, and writes the config for the ones you leave
marked.

```bash
guards init                # write a starter rules file
guards install             # detect what is installed, let you pick, wire it up
guards status              # who is guarded, and what proved it is installed
```

`guards install` with no arguments **looks at your machine first** and pre-checks
what it found:

```
$ guards install

instalar o motor de guardas em quais harness?

[x] pi       pi                 /Users/lucas/.pi/agent/bin/pi
[x] omp      omp                /Users/lucas/.local/bin/omp
[x] claude   Claude Code        /Users/lucas/.local/bin/claude
[ ] copilot  Copilot CLI        /Users/lucas/.copilot
[x] gemini   Gemini CLI         /opt/homebrew/bin/gemini
[x] agy      Antigravity CLI    /Users/lucas/.local/bin/agy

↑↓ move · espaço marca · a todas · i inverte · enter instala · q cancela
```

Untick what you do not want and press enter. The path on the right is *why* each
one was found: a binary on `PATH`, or the directory the harness created when it
first ran.

| you type | what happens |
|---|---|
| `guards install` | the checkbox above |
| `guards install claude gemini` | installs those two, no prompt |
| `guards install --all` | every harness, detected or not |
| `guards install --dry-run` | prints exactly what would be written, writes nothing |
| no terminal (CI) | installs the detected ones and says which |

Every install is idempotent, backs up the file it touches (`.bak`), and
`guards uninstall` removes only our entry — other tools' hooks in the same file
stay untouched.

Aliases work too: `claude-code`, `copilot-cli`, `gemini-cli`, `antigravity`, `oh-my-pi`.

Requirements: Node ≥ 20. No dependencies, no build step.

## Write a guard

Rules live in `~/.config/simple-llm-guards/guards.jsonc` (override with `GUARDS_CONFIG`).
JSONC means you can comment your rules — which you should, because in six months
you will not remember why that regex exists.

```jsonc
{
  "version": 1,
  "rules": [
    {
      "id": "no-rm-rf-root",
      "tools": ["shell"],
      "when": [{ "arg": "command", "regex": "rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+(/|~)" }],
      "reason": "apontar para um diretorio especifico."
    }
  ]
}
```

That single rule blocks `Bash`, `run_shell_command`, `run_command`, `command` and
`CommandLine` — in pi, omp, Claude Code, Copilot CLI, Gemini CLI and agy.

### Rule language

```jsonc
{
  "id": "unique-name",            // required
  "action": "deny",               // "deny" (default) | "allow"
  "enabled": true,                // false skips the rule without deleting it
  "tools": ["shell", "write"],    // canonical tools; omit to match every tool
  "when": [ /* conditions — ALL must match */ ],
  "reason": "sent to the agent"   // why it was blocked, in one sentence
}
```

A **condition** is one of:

| shape | matches when |
|---|---|
| `{ "arg": "command", "regex": "...", "flags": "i" }` | the named argument matches |
| `{ "arg": "file_path", "glob": ["**/.ssh/**"] }` | the path matches (`~` and cwd resolved) |
| `{ "arg": "command", "contains": "rm -rf" }` | substring |
| `{ "arg": "tool", "equals": "npm" }` | exact |
| `{ "anyArg": true, "contains": "AKIA" }` | any string anywhere in the arguments |
| `{ "anyOf": [ ...conditions ] }` | at least one nested condition matches (your "or") |

Add `"not": true` to any condition to invert it.

**Canonical tools** — `shell`, `read`, `write`, `edit`, `fetch`, `search`, `mcp`, `other`.
**Canonical arguments** — `command` (shell), `file_path` (read/write/edit). Native keys
stay in place too, so `"arg": "AbsolutePath"` still works if you need it.

Rules are evaluated in order; **first match wins**. No match means allow.

### Failure behaviour

| situation | result |
|---|---|
| rules file missing | every call is allowed — guards are off until you write one |
| rules file broken | the call is **blocked**, with the parse error as the reason |
| stdin unparseable | the call is **blocked** |
| unknown `--harness` | the call is **blocked** |

Set `"failOpen": true` at the top level to downgrade the two error cases to allow.
Fail-closed is the default on purpose: a guard that quietly stops guarding is
worse than one that gets in the way.

## Manage your guards

Every guard is a line in `guards.jsonc`. You can edit that file by hand — it is
JSONC precisely so the *reason* a rule exists lives next to it — or drive it from
a menu.

### `guards manage`

A full-screen menu in any terminal:

```
$ guards manage

guards  ~/.config/simple-llm-guards/guards.jsonc

  ● on  no-secret-files        read, write, edit, shell — arquivo **/.env, **/*.pem
  ● on  no-rm-rf-root          shell — command =~ /rm\s+(-[a-zA-Z]*[rf]...)+(/|~)/
  ○ off  no-git-destruction    shell — command =~ /git\s+.*(push\s+(--force|-f)\b|.../
  ● on  no-drop-database       shell — command =~ /\b(DROP\s+(DATABASE|TABLE)...

↑↓ move · espaço liga/desliga · n nova · d apaga · q sai
```

- **space** toggles a guard on or off
- **n** opens the new-guard wizard
- **d** deletes a guard (comments and all — this one is not undoable)
- **q** quits

### `/guards manage` inside pi and omp

The extension registers a slash command, so the same menu opens inside the agent:

```
> /guards manage
```

It uses the harness's own dialogs (`select`/`confirm`/`input`) and the same
`manage.js` core — only the rendering differs. **This only works in pi and omp.**
The other four harnesses run command hooks (JSON in, JSON out) and have no
in-process UI, so for them the menu lives in a separate terminal.

### Creating a guard

The wizard asks three things and writes a valid rule:

```
? que tipo de guarda?
  ▸ bloquear um comando              ex: rm -rf /, git push --force, npm publish
    bloquear um arquivo              ex: **/.env, **/.ssh/**, *.pem
    bloquear um texto em qualquer argumento
    escrever a regra na mão

? padrão/texto para bloquear: npm\s+publish\b
? motivo: publicar sem revisar
✓ criada — no-publish  shell — command =~ /npm\s+publish\b/
```

Four templates: command, path, text-in-any-argument, and raw JSON. The id is
derived from the label (`Bloquear deploy!` → `bloquear-deploy`), and an invalid
regex is rejected before the file is touched.

Scriptable equivalents:

```bash
guards add --kind command --value 'npm\s+publish\b' --id no-publish --reason 'publicar sem revisar'
guards enable <id>      # same as guards disable, stated the other way round
guards disable <id>
guards rm <id>
```

**Edits are surgical.** Toggling a guard inserts or removes one line; nothing
else in the file changes. Your comments and your formatting survive.

## Test a rule before you install it

```bash
$ guards check --harness gemini --tool run_shell_command --args '{"command":"rm -rf /"}'
harness  gemini
tool     run_shell_command -> shell
args     {"command":"rm -rf /"}
verdict  DENY (no-rm-rf-root)
reason   no-rm-rf-root: rm -rf na raiz apaga o disco inteiro.
```

Exit code `3` for deny, `0` for allow — usable in a test.

You can also pipe a real payload:

```bash
echo '{"tool_name":"Bash","tool_input":{"command":"cat .env"}}' \
  | guards check --harness claude
```

## How it works

```
src/
├── engine.js            evaluate(), glob matching, conditions. No harness code.
├── normalize.js         native tool/arg names -> canonical names
├── rules.js             JSONC parsing + validation (fails loudly on typos)
├── starter.js           the rules `guards init` writes
├── guard-hook.js        the one process subprocess harnesses talk to
├── rules-edit.js        surgical JSONC editing: toggle, delete, insert
├── manage.js            the shared menu core both surfaces call
├── tui.js               the standalone guards manage screen
├── cli.js               init / install / uninstall / status / rules / manage / check
└── adapters/
    ├── pi.js            in-process for pi and omp
    ├── claude.js        tool_name / tool_input  -> hookSpecificOutput.permissionDecision
    ├── copilot.js       toolName / toolArgs     -> permissionDecision
    ├── gemini.js        tool_name / tool_input  -> decision / reason
    └── agy.js           toolCall.{name,args}    -> decision / reason
```

An adapter is three functions:

```js
export const harness = 'gemini';
export const event   = 'BeforeTool';
export function parse(payload)   { /* native payload -> engine request */ }
export function format(decision){ /* engine verdict -> native deny JSON */ }
```

That is the entire cost of supporting a new harness.

## Tests

```bash
npm test     # 71 tests: engine, adapters, the hook binary, the JSONC editor, the menu,
            # harness detection, and install/uninstall against a throwaway HOME
```

The end-to-end tests spawn `guard-hook.js` exactly the way a harness does — JSON
on stdin, verdict on stdout, exit code checked — for all four subprocess harnesses.

## Uninstall

```bash
guards uninstall          # same picker, removes our entry from each harness
```

Other tools' hooks in the same file are left alone. Shared settings files keep the
`.bak` written at install time.

## Releasing

Merging to `main` is the release. `.github/workflows/release.yml` runs on every
push to `main` and:

1. runs the tests — a red suite publishes nothing,
2. computes the next version from the commits since the last tag,
3. commits the bump and pushes the tag back to `main`,
4. publishes to npm with `--provenance`,
5. opens the matching GitHub release.

The version comes from [conventional commits](https://www.conventionalcommits.org):

| commit | version |
|---|---|
| `feat: …` | minor |
| `fix:` / `perf:` / `refactor:` | patch |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `chore:` / `docs:` / `test:` / `ci:` | nothing published |

`chore(release): v1.2.0 [skip release]` is the one commit that does not trigger
the next run.

### One-time setup

- **npm automation token** → repository secret `NPM_TOKEN` (a granular token
  scoped to this package, with *Read and write*).
- Optionally swap the token for
  [trusted publishing](https://docs.npmjs.com/trusted-publishers/): delete the
  secret, set the workflow name in the npm package settings, and the
  `id-token: write` permission already in the workflow is enough.

### Running it locally first

```bash
npm version 0.2.0 --no-git-tag-version
npm pack --dry-run     # see exactly what would ship
npm publish --dry-run  # talk to the registry without publishing
```

### Where the runtime ends up

`npx` runs from a cache directory npm is free to delete, so installing copies
the runtime next to your rules file and points every config there:

```
~/.config/simple-llm-guards/
├── guards.jsonc     ← your rules
└── runtime/         ← the hook process every harness calls
```

Set `GUARDS_CONFIG` and both move together. `guards status` warns you when the
installed runtime is older than the package you just ran.