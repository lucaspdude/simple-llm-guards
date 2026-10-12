// The starter rule set written by `guards init`.
//
// Rules are written in the canonical vocabulary (`shell`, `read`, `write`,
// `command`, `file_path`) so the same entry covers bash, run_shell_command,
// run_command, CommandLine and `rm -rf /` in every harness at once.
//
// String.raw keeps the regexes byte-for-byte as written here: a JSON string that
// holds a regex needs its backslashes doubled, which is exactly what a raw
// template does not do for us. So we double them by hand, once, and only here.

export const STARTER_RULES = String.raw`// simple-llm-guards — one rule set, every harness.
// Canonical tools: shell, read, write, edit, fetch, search, mcp, other
// Canonical args: command (shell), file_path (read/write/edit)
//
// rule      = { id, action?: "deny" | "allow", tools?: [...], when: [...], reason }
// condition = { arg?, anyArg?, regex|contains|equals|glob, flags?, not? }
// anyOf     = [...] matches when any nested condition matches (how a rule says "or")

{
  "version": 1,
  // Rules are evaluated in order; the first match wins.
  // Set "failOpen": true to let tool calls through when this file is broken.
  "rules": [
    {
      "id": "no-secret-files",
      "action": "deny",
      "tools": ["read", "write", "edit", "shell"],
      "when": [
        { "anyOf": [
          { "arg": "file_path", "glob": ["**/.env", "**/.env.*", "**/id_rsa", "**/id_ed25519", "**/*.pem", "**/*.key", "**/credentials.json"] },
          { "arg": "command", "regex": "(cat|less|head|tail|cp|scp|curl|base64)\\s+[^|&;]*(\\.env|id_rsa|id_ed25519|\\.pem)" }
        ] }
      ],
      "reason": "esse arquivo costuma conter credenciais. leia o exemplo (.env.example) em vez do arquivo real."
    },
    {
      "id": "no-rm-rf-root",
      "action": "deny",
      "tools": ["shell"],
      "when": [{ "arg": "command", "regex": "rm\\s+(-[a-zA-Z]*[rf][a-zA-Z]*\\s+)+(/|~|\\$HOME)(\\s|$)" }],
      "reason": "rm -rf na raiz apaga o disco inteiro. aponte para um diretorio especifico."
    },
    {
      "id": "no-git-destruction",
      "action": "deny",
      "tools": ["shell"],
      "when": [
        { "arg": "command", "regex": "git\\s+.*(push\\s+(--force|-f)\\b|reset\\s+--hard|clean\\s+-[a-zA-Z]*f|checkout\\s+--)" }
      ],
      "reason": "esse comando git descarta trabalho que nao foi commitado. commite antes."
    },
    {
      "id": "no-drop-database",
      "action": "deny",
      "tools": ["shell"],
      "when": [{ "arg": "command", "regex": "\\b(DROP\\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\\s+TABLE)\\b", "flags": "i" }],
      "reason": "isso apaga dados de forma nao reversivel. confirme com uma pessoa antes."
    },
    {
      "id": "no-ssh-key-write",
      "action": "deny",
      "tools": ["write", "edit", "shell"],
      "when": [{ "arg": "file_path", "glob": ["**/.ssh/**", "**/.aws/credentials", "**/.gnupg/**"] }],
      "reason": "essa e uma chave de identidade da maquina, nao codigo do projeto."
    }
  ]
}
`;