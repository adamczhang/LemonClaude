<p align="center">
  <img src="assets/banner.svg" alt="A lobster hugging a lemon, next to the words LemonClaude: run Claude Code on a local Lemonade model" width="100%">
</p>

# LemonClaude 🍋

Run Claude Code on a local model. LemonClaude is a Claude Code mod that adds a [Lemonade](https://github.com/lemonade-sdk/lemonade) model to Claude Code's model selector. Pick 🍋 and requests go to the model on your machine. Pick a Claude model and they go back to Claude. You don't need to restart.

- **One model selector.** Lemonade appears next to Opus, Sonnet and Haiku, and `/model <id>` works too.
- **Switch mid-session.** The conversation carries on. Only where the next request goes changes.
- **Subagents follow.** While 🍋 is selected, every request goes to Lemonade, subagents included.
- **Nothing is left behind.** The environment is restored when you pick Claude again and when the session ends.

## Requirements

| | Version |
| --- | --- |
| [Claude Code](https://claude.com/claude-code) | 2.1.287 or later (the mod API is early access) |
| [Lemonade Server](https://github.com/lemonade-sdk/lemonade) | 2026.40.0 or later, which serves the Anthropic-compatible `/v1/messages` |
| A downloaded chat model | For Claude Code's tools to work, pick one Lemonade labels `tool-calling` |

LemonClaude was developed on Windows 11. The mod runs inside Claude Code and makes no OS calls of its own, so it should work anywhere Claude Code and Lemonade run.

## Install

Clone the repository:

```bash
git clone https://github.com/adamczhang/LemonClaude.git
```

Load it for one session:

```bash
claude --plugin-dir /path/to/LemonClaude
```

To load it in every session, the desktop app included, add it to the `env` block of `~/.claude/settings.json`:

```json
"env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/LemonClaude" }
```

On Windows, escape the backslashes, as in `"D:\\Projects\\LemonClaude"`.

## Use

1. Start Lemonade Server and download a chat model, for example with `lemonade pull`.
2. Start Claude Code. The model selector (`/model`) now shows an entry such as `🍋 Qwen3.5-4B-GGUF · Local via Lemonade`.
3. Pick it. The status line shows `🍋 <model> (Lemonade)` while requests go to Lemonade.
4. To go back, pick any Claude model.

Claude Code allows only one custom entry in the selector. LemonClaude offers the model you chose last time. The first time, it offers the first downloaded model that supports tool calling. To offer a different model:

| Command | What it does |
| --- | --- |
| `/lemonade` | Opens a picker of downloaded chat models, showing size, tool support and whether each is loaded |
| `/lemonade <model>` | Offers that model. It takes the exact id or any unique part of it, such as `/lemonade qwen` |
| `/lemonade list` | Lists the models, what the selector offers, and where requests go now |

If 🍋 is already selected, changing the model moves the session to the new one at once.

### When Lemonade isn't running

The entry still appears, offering the model from last time, and its description says Lemonade isn't running. Start Lemonade before picking it. If Lemonade doesn't answer a request, a toast says so and suggests picking a Claude model.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LEMONADE_BASE_URL` | `http://127.0.0.1:13305` | Where Lemonade Server listens |
| `LEMONCLAUDE_LEMONADE_MODEL` | `Qwen3.5-4B-GGUF` | The model to offer while Lemonade is down and no earlier choice is remembered |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | — | If you've set this yourself for something other than Lemonade, LemonClaude leaves your entry alone |

## How it works

- **The selector entry** comes from Claude Code's `ANTHROPIC_CUSTOM_MODEL_OPTION`, `_NAME` and `_DESCRIPTION` variables. LemonClaude sets them when the session starts.
- **Routing** happens in a `turn.step` hook, which reads the session's selected model before each request.
  - **Lemonade model selected:** the hook saves the original values, then points `ANTHROPIC_BASE_URL` at Lemonade and sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Claude Code reads both on every request, and each request names the Lemonade model.
  - **Claude model selected:** the hook restores the saved values.
- **Session end:** the environment is also restored when the session ends, including on `/clear`.
- **Model aliases:** unlike `lemonade launch claude`, LemonClaude leaves the `ANTHROPIC_DEFAULT_*_MODEL` aliases alone. Pointing them at Lemonade would make picking Opus resolve to the Lemonade model.

## Known limitations

- **Disabling the mod:** pick a Claude model before you disable LemonClaude. Otherwise the environment keeps pointing at Lemonade until the session ends.
- **Selector refresh:** `/lemonade <model>` updates the entry at once, but a selector that caches its list may show the change only in a new session. `/model <id>` works right away.
- **API keys:** a Lemonade server that requires `LEMONADE_API_KEY` isn't supported yet.
- **Context window:** Claude Code budgets context as if it were talking to Claude. The real limit is the `ctx_size` Lemonade sets for the model.
- **Background calls:** Claude Code may print an `unrecognized_model` notice. Its background calls (session titles and similar) ask for Claude models, and Lemonade answers them with a 404 while 🍋 is selected.
- **Model quality:** small local models follow Claude Code's tool protocol less reliably than Claude does. Models without the `tool-calling` label may fail to use tools at all.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No 🍋 entry in the selector | Check the mod is loaded: run `/lemonade list`. If the command is unknown, check `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` |
| "Lemonade didn't answer" toast | Start Lemonade Server, or check `LEMONADE_BASE_URL` |
| The first reply is slow | Lemonade loads the model on its first request |
| Tools fail or the model ignores them | Pick a model labeled `tool-calling` (`/lemonade list` shows `tools`) |
| Requests still go to Lemonade after removing the mod | Start a new session, or unset `ANTHROPIC_BASE_URL` in that shell |

## Development

```bash
claude plugin validate /path/to/LemonClaude
```

```bash
claude plugin test /path/to/LemonClaude
```

The code is in `hooks/register.tsx`, its state contract in `types/index.d.ts`, and its tests in `tests/lemonade.test.ts`. The tests run against a fake Lemonade, so they need no server. The mod API is early access, so re-run `validate` and `test` after each Claude Code update.

Don't develop LemonClaude in a session that has it loaded. A bug in its `turn.step` hook would break that session's own requests.

## License

[MIT](LICENSE) © 2026 Adam Zhang
