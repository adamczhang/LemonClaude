# Changelog

All notable changes to LemonClaude are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-07

First release.

### Added

- A Lemonade model in Claude Code's model selector, shown as `🍋 <model>`. Picking it sends requests to Lemonade Server. Picking a Claude model sends them back. No restart is needed.
- Routing that follows the session's selected model on every request, subagents included.
- `/lemonade`, a picker of downloaded chat models showing size, tool support and loaded state.
- `/lemonade <model>`, which offers a model by exact id or any unique part of it.
- `/lemonade list`, which shows the models, the current offer and where requests go.
- A status line entry, `🍋 <model> (Lemonade)`, while requests go to Lemonade.
- Remembering the last model chosen across sessions.
- An entry even when Lemonade is down at startup, offering the remembered model (else `LEMONCLAUDE_LEMONADE_MODEL`, else `Qwen3.5-4B-GGUF`). A toast appears when Lemonade doesn't answer.
- `LEMONADE_BASE_URL` for a server other than `http://127.0.0.1:13305`.
- Restoring the original environment when you go back to Claude and when the session ends.

[0.1.0]: https://github.com/adamczhang/LemonClaude/releases/tag/v0.1.0
