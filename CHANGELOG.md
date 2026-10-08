# Changelog

All notable changes to LemonClaude are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

This release brings LemonClaude to the Claude Code desktop app and lets you manage Lemonade's models from inside Claude Code. The desktop app's model picker lists only Claude models, so these changes give it its own way to switch and a model manager to choose from.

### Added

- A model manager. `/lemonade` draws a model list in the transcript, laid out like Lemonade's own:
  - Search, a **Downloaded only** switch, and three sections: **Active** (loaded), **Downloaded** (ready to use) and **Suggested** (every other chat model Lemonade offers, grouped by recipe).
  - **Use** switches requests to a downloaded model.
  - **Download** starts a download that Lemonade runs itself, with live progress in the row and Lemonade's reason if it fails.
  - Models whose recipe this machine can't run are left out.
- `/lemonade on [model]`, which sends every request to the offered Lemonade model whatever the model selector shows. `/lemonade off`, or picking another model in a picker, hands routing back. This is how to use Lemonade from the desktop app. Ending the session turns it off.
- Starting Lemonade Server on Windows when a request needs it and it isn't running, then waiting up to 60 seconds for it. `/lemonade`, `/lemonade on` and `/lemonade <model>` start it too. The server is started detached, so it keeps running after the session. Set `LEMONCLAUDE_AUTOSTART=0` to turn this off.
- The selector entry says "starts when picked" while Lemonade is down and LemonClaude can start it.
- Good-neighbour behavior on a Lemonade server shared with other apps:
  - Models are loaded explicitly with a bounded window, `LEMONCLAUDE_CTX_SIZE`, 64K by default, never by Lemonade's auto-load at its largest window. A model that isn't downloaded is never loaded, since that would download it.
  - The model in use is pinned, and unpinned on `/lemonade off`, on picking another model, and at session end. LemonClaude only unpins models it pinned, remembered across sessions. A pin a crashed session left is released after an hour.
  - When another app has pinned Lemonade's chat models, one toast names them. When a load made Lemonade unload another app's model, it says so.
  - Subagents of another plugin's agent type are passed through untouched.
  - The model manager marks models another app has pinned.
  - `/lemonade on` loads before switching, says "Loaded … with a 64K window" or exactly why not, and doesn't switch to a model that can't load.
- Support for `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`. With it set, some Claude Code versions (2.1.287) refuse a mod's own network requests, and LemonClaude reaches Lemonade through `curl` instead.
- A load that fails for lack of GPU memory says so, and suggests freeing some, a smaller window or a smaller model. Another program, such as a second Lemonade server, can hold memory this server can't see.

### Changed

- `/lemonade` opens the model manager instead of the picker pane, which the desktop app didn't show.
- Routing to Lemonade changes only `ANTHROPIC_BASE_URL`. It no longer sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, which turns off telemetry, not routing.
- A downloaded model counts as a chat model unless a label says otherwise, so a model pulled without labels can be used.
- Sizes read as Lemonade shows them (`650 MB`, `2.10 GB`). The selector entry no longer says whether a model is loaded, since that goes stale.
- When Lemonade is down, `/lemonade list` says so in one line and says how to start it.

### Fixed

- A conflict with another app's pinned model no longer shows as "Lemonade didn't answer". Lemonade itself answers such a chat request with a misleading "model not found".
- Lemonade no longer loads LemonClaude's model with its largest window (262K tokens), which took several gigabytes more GPU memory than needed.

## [0.1.0] - 2026-10-07

First release.

### Added

- A Lemonade model in Claude Code's model selector, shown as `🍋 <model>`. Picking it sends requests to Lemonade Server, and picking a Claude model sends them back, with no restart.
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
