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
guards init                # write a starter rules file
guards install             # wire every harness you have installed
guards status              # who is guarded, and from where
```

`guards install <harness>` takes one name (`pi`, `omp`, `claude`, `copilot`,
`gemini`, `agy`, plus aliases like `claude-code`, `antigravity`). Every install is
idempotent, backs up the file it touches (`.bak`), and understands `--dry-run`.

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
├── cli.js               init / install / uninstall / status / rules / check
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
npm test     # 28 tests: engine, every adapter, and the real hook binary end to end
```

The end-to-end tests spawn `guard-hook.js` exactly the way a harness does — JSON
on stdin, verdict on stdout, exit code checked — for all four subprocess harnesses.

## Uninstall

```bash
guards uninstall          # removes our entry from every harness
```

Shared settings files are restored from the `.bak` written at install time.