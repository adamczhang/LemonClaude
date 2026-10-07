# Sidekick

A Claude Code mod that lets a session switch to a local model served by [Lemonade](https://github.com/lemonade-sdk/lemonade) and back, without restarting.

## Use

| Command | What it does |
| --- | --- |
| `/lemonade` | Opens a picker listing Lemonade's downloaded chat models (size, tool support, loaded state) plus "Claude (Lemonade off)". |
| `/lemonade <model>` | Switches to that model. Takes the exact id or any unique part of it (`/lemonade qwen`). |
| `/lemonade off` | Switches back to Claude. |
| `/lemonade list` | Lists the models and shows which one is active. |

While Lemonade is on, the status line shows `🍋 <model> (Lemonade)`.

Set `LEMONADE_BASE_URL` to use a server other than `http://127.0.0.1:13305`.

## How it works

Claude Code's built-in `/model` picker can't be extended by a mod, so the mod uses its own command and picker. Switching does two things:

1. It sets the same variables that `lemonade launch claude` sets, but on the running process through `$.env.set`: `ANTHROPIC_BASE_URL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. Claude Code reads these per request, so the next request goes to Lemonade's Anthropic-compatible `/v1/messages`.
2. A `turn.step` hook rewrites the model on every request, for the main loop and for subagents.

Before the first switch, the mod saves the earlier values of those variables in `$.state`. `/lemonade off` restores them, and so does the end of the session (including `/clear`).

## Limits

- **`/model` doesn't turn Lemonade off.** While Lemonade is on, its model answers every request. Use `/lemonade off` to go back to Claude.
- **Turn Lemonade off before disabling the mod.** Otherwise the environment keeps pointing at Lemonade.
- **No Lemonade API key.** A server that requires `LEMONADE_API_KEY` isn't supported yet. Claude Code sends its usual credential header to the local server, and Lemonade ignores it when no key is configured.
- **Context window.** Claude Code still budgets context as if it were talking to Claude. Lemonade's `ctx_size` for the model sets the real limit.
- **Background tasks.** Claude Code may print an `unrecognized_model` notice. Background calls that ask for Claude models get a 404 from Lemonade.

## Develop

```bash
claude plugin validate D:\Projects\Claude\Sidekick
```

```bash
claude plugin test D:\Projects\Claude\Sidekick
```

```bash
claude --plugin-dir D:\Projects\Claude\Sidekick
```

Developed against Claude Code 2.1.287–2.1.289 and Lemonade 2026.40.0. The mod API is early access, so re-run `validate` and `test` after each Claude Code update.
