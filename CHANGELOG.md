# Changelog

All notable changes to LemonClaude are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- On Windows, starting Lemonade Server when a request is about to go to it and it isn't running, then waiting up to 60 seconds for it. `/lemonade` and `/lemonade <model>` start it too. The server is started detached, so it keeps running after the session. Set `LEMONCLAUDE_AUTOSTART=0` to turn this off.
- The selector entry says "starts when picked" while Lemonade is down and LemonClaude can start it.
- `/lemonade on [model]` sends every request to the offered Lemonade model, whatever the model selector shows, and `/lemonade off` hands routing back to the selector. This is how to use Lemonade from the desktop app, whose model picker lists only Claude models. Ending the session turns it off.

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

[Unreleased]: https://github.com/adamczhang/LemonClaude/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adamczhang/LemonClaude/releases/tag/v0.1.0
