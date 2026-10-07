# Sidekick

A Claude Code mod that adds a local [Lemonade](https://github.com/lemonade-sdk/lemonade) model to Claude Code's model selector. Pick 🍋 in the selector (or `/model <id>`) and requests go to Lemonade; pick a Claude model and they go back to Claude. No restart is needed.

## Use

- **Model selector:** at startup the mod adds one entry, such as `🍋 Qwen3.5-4B-GGUF`. Claude Code allows only one custom entry. The mod offers the model you chose last; the first time, it offers the first downloaded model that supports tool calling.
- **`/lemonade`** opens a picker of Lemonade's downloaded chat models, with size, tool support and loaded state. Your choice becomes the selector's entry.
- **`/lemonade <model>`** does the same from the command line. It takes the exact id or any unique part of it (`/lemonade qwen`).
- **`/lemonade list`** shows the models, what the selector offers, and where requests go now.

While requests go to Lemonade, the status line shows `🍋 <model> (Lemonade)`.

Set `LEMONADE_BASE_URL` to use a server other than `http://127.0.0.1:13305`.

## How it works

- **The selector entry** comes from `ANTHROPIC_CUSTOM_MODEL_OPTION`, `_NAME` and `_DESCRIPTION`. The mod sets them with `$.env.set` when the session starts. If you've set your own `ANTHROPIC_CUSTOM_MODEL_OPTION` for something other than Lemonade, the mod leaves it alone.
- **Routing** happens in a `turn.step` hook. Before each request it reads the session's model.
  - **Lemonade model selected:** the hook points `ANTHROPIC_BASE_URL` at Lemonade's Anthropic-compatible `/v1/messages` and sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Claude Code reads both on every request. It saves the original values first. Every request names that model, subagents included.
  - **Claude model selected:** the hook restores the saved values.
- **Session end:** the environment is also restored when the session ends, including on `/clear`.
- **Model aliases:** unlike `lemonade launch claude`, the mod leaves the `ANTHROPIC_DEFAULT_*_MODEL` aliases alone. Pointing them at Lemonade would make picking Opus resolve to the Lemonade model.

## Limits

- **Disabling the mod:** pick a Claude model before you disable it. Otherwise the environment keeps pointing at Lemonade.
- **Selector refresh:** changing the entry mid-session (`/lemonade <model>`) updates the variables at once. A selector that caches its list may show the change only in a new session; `/model <id>` works right away.
- **API keys:** a Lemonade server that requires `LEMONADE_API_KEY` isn't supported yet. Claude Code sends its usual credential header to the local server, and Lemonade ignores it when no key is set.
- **Context window:** Claude Code budgets context as if it were talking to Claude. Lemonade's `ctx_size` for the model sets the real limit.
- **Background calls:** Claude Code may print an `unrecognized_model` notice. Background calls (titles and similar) that ask for Claude models get a 404 from Lemonade while it's selected.

## Load it

For one terminal session:

```bash
claude --plugin-dir D:\Projects\Claude\Sidekick
```

For every session, including the desktop app, add it to the `env` block of `~/.claude/settings.json` (here `D:\ClaudeHome\settings.json`):

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "D:\\Projects\\Claude\\Sidekick" }
```

## Develop

```bash
claude plugin validate D:\Projects\Claude\Sidekick
```

```bash
claude plugin test D:\Projects\Claude\Sidekick
```

Developed against Claude Code 2.1.287–2.1.289 and Lemonade 2026.40.0. The mod API is early access, so re-run `validate` and `test` after each Claude Code update.
