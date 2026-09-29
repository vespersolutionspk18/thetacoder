# Quickstart

This page gets you from install to a useful first theta session.

## Install

Theta is distributed as an npm package:

```bash
npm install -g --ignore-scripts @theta/coding-agent
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Theta does not require install scripts for normal npm installs.

### Uninstall

Use the package manager that installed theta. The curl installer uses npm globally, so curl and npm installs are removed with npm:

```bash
# curl installer or npm install -g
npm uninstall -g @theta/coding-agent

# pnpm
pnpm remove -g @theta/coding-agent

# Yarn
yarn global remove @theta/coding-agent

# Bun
bun uninstall -g @theta/coding-agent
```

Uninstalling theta leaves settings, credentials, sessions, and installed theta packages in `~/.theta/agent/`.

Then start theta in the project directory you want it to work on:

```bash
cd /path/to/project
theta
```

## Authenticate

Theta can use subscription providers through `/login`, or API-key providers through environment variables or the auth file.

### Option 1: subscription login

Start theta and run:

```text
/login
```

Then select a provider. Built-in subscription logins include Claude Pro/Max, ChatGPT Plus/Pro (Codex), and GitHub Copilot.

### Option 2: API key

Set an API key before launching theta:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
theta
```

You can also run `/login` and select an API-key provider to store the key in `~/.theta/agent/auth.json`.

See [Providers](providers.md) for all supported providers, environment variables, and cloud-provider setup.

## First session

Once theta starts, type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, theta gives the model four tools:

- `read` - read files
- `write` - create or overwrite files
- `edit` - patch files
- `bash` - run shell commands

Additional built-in read-only tools (`grep`, `find`, `ls`) are available through tool options. Theta runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Give theta project instructions

Theta loads context files at startup. Add an `AGENTS.md` file to tell it how to work in a project:

```markdown
# Project Instructions

- Run `npm run check` after code changes.
- Do not run production migrations locally.
- Keep responses concise.
```

Theta loads:

- `~/.theta/agent/AGENTS.md` for global instructions
- `AGENTS.md` or `CLAUDE.md` from parent directories and the current directory

If a directory contains `AGENTS.override.md`, Theta loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory.

Restart theta, or run `/reload`, after changing context files.

## Common things to try

### Reference files

Type `@` in the editor to fuzzy-search files, or pass files on the command line:

```bash
theta @README.md "Summarize this"
theta @src/app.ts @src/app.test.ts "Review these together"
```

Images or text can be pasted with Ctrl+V (Alt+V on Windows); images can also be dragged into supported terminals.

### Run shell commands

In interactive mode:

```text
!npm run lint
```

The command output is sent to the model. Use `!!command` to run a command without adding its output to the model context.

### Switch models

Use `/model` or Ctrl+L to choose a model for the current session. Press Ctrl+S in the model picker to save the highlighted model as the startup default. Use `/thinking` to choose a thinking level for the current session, or Ctrl+S in that picker to save the startup default thinking level. Use Shift+Tab to cycle thinking level. Use Ctrl+P / Shift+Ctrl+P to cycle through scoped models.

### Continue later

Sessions are saved automatically:

```bash
theta -c                  # Continue most recent session
theta -r                  # Browse previous sessions
theta --name "my task"    # Set session display name at startup
theta --session <path|id> # Open a specific session
```

Inside theta, use `/resume`, `/new`, `/tree`, `/fork`, and `/clone` to manage sessions.

### Non-interactive mode

For one-shot prompts:

```bash
theta -p "Summarize this codebase"
cat README.md | theta -p "Summarize this text"
theta -p @screenshot.png "What's in this image?"
```

Use `--mode json` for JSON event output or `--mode rpc` for process integration.

## Next steps

- [Using Theta](usage.md) - interactive mode, slash commands, sessions, context files, and CLI reference.
- [Providers](providers.md) - authentication and model setup.
- [Settings](settings.md) - global and project configuration.
- [Keybindings](keybindings.md) - shortcuts and customization.
- [Theta Packages](packages.md) - install shared extensions, skills, prompts, and themes.

Platform notes: [Windows](windows.md), [Termux](termux.md), [tmux](tmux.md), [Terminal setup](terminal-setup.md), [Shell aliases](shell-aliases.md).

