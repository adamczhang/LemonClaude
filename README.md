<p align="center">
  <img src="assets/banner.svg" alt="A lobster hugging a lemon, next to the words LemonClaude: run Claude Code on a local Lemonade model" width="100%">
</p>

# LemonClaude 🍋

**Claude Code with a local model one command away.**

LemonClaude is a Claude Code mod that lets a session switch between Claude and a model running on your own machine through [Lemonade](https://github.com/lemonade-sdk/lemonade). The switch happens mid-conversation, without a restart, and you can switch back just as fast.

## Why

Claude Code is a great place to work: it knows your codebase, runs your tools, edits files and plans with you. Most of the time you want Claude doing that work. But some requests don't need a frontier model, and some shouldn't leave your machine:

- **Private code.** Code under an NDA, or not yours to share, can stay on your laptop.
- **No connection.** On a plane, or behind a firewall, a local model still answers.
- **Routine work.** Renames, boilerplate and quick questions don't need to spend your Claude usage.
- **Curiosity.** You can see how an open model does inside a real agent, with the same tools, prompts and project.

Lemonade runs open models on your own GPU or NPU. It speaks the same Messages API that Claude Code speaks, so the two already fit together. What's missing is a way to move between them inside a session. Lemonade's own `lemonade launch claude` starts a separate Claude Code session that runs only on the local model.

LemonClaude fills that gap. Pick 🍋 and the next request goes to the model on your machine, subagents included. Pick Claude and the next one goes back to Claude. The conversation, your tools and the files you're editing stay as they are. Only where the next request goes changes.

> A 4-billion-parameter model on a laptop is not Claude. Use it for what it's good at, like small edits, explanations and drafts. Switch back when the task needs real reasoning. LemonClaude makes switching cheap enough that you can.

## What it does

- **🍋 in the model selector.** In the terminal, a Lemonade model sits next to Opus, Sonnet and Haiku.
- **A model manager inside Claude Code.** `/lemonade` lists every chat model Lemonade offers, laid out like Lemonade's own model manager. It shows what's loaded, what's downloaded and ready, and what you can download, with search and live download progress.
- **Works in the desktop app.** The desktop app's picker lists only Claude models, so `/lemonade on` and the model manager's **Use** button switch there instead.
- **Starts Lemonade for you.** On Windows, if Lemonade Server isn't running when a request needs it, LemonClaude starts it.
- **A good neighbour.** It loads its model with a bounded window and pins it while in use. It never touches another app's models, and when another app holds Lemonade's chat slot it says exactly which one. See [Sharing Lemonade with other apps](#sharing-lemonade-with-other-apps).
- **Leaves nothing behind.** Going back to Claude, or ending the session, restores Claude Code's settings exactly as they were.

## Quick start

1. Install [Lemonade](https://github.com/lemonade-sdk/lemonade) and download a chat model that supports tool calling, such as `Qwen3.5-4B-GGUF`.
2. Load LemonClaude into Claude Code (see [Install](#install)).
3. In a new session, type `/lemonade` and press **Use** on a model. LemonClaude loads it (a toast says "Loaded … with a 64K window"), and the status line shows `🍋 <model> (Lemonade)`.
4. To go back, press **Back to Claude**, type `/lemonade off`, or pick a Claude model.

## Requirements

| | Version |
| --- | --- |
| [Claude Code](https://claude.com/claude-code) | 2.1.287 or later (the mod API is early access) |
| [Lemonade Server](https://github.com/lemonade-sdk/lemonade) | 2026.40.0 or later, which serves the Anthropic-compatible `/v1/messages` |
| A downloaded chat model | For Claude Code's tools to work, pick one Lemonade labels `tool-calling` |

LemonClaude was built and tested on Windows 11, on an AMD Ryzen AI laptop with an NVIDIA GPU. Apart from starting Lemonade Server, which is Windows only, it runs entirely inside Claude Code, so it should work anywhere Claude Code and Lemonade run.

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

On Windows, escape the backslashes, as in `"D:\\Projects\\LemonClaude"`. Settings are read when a session starts, so open a new session afterwards.

## Use

### In the terminal

1. Start `claude`. The model selector (`/model`) shows an entry such as `🍋 Qwen3.5-4B-GGUF · Local via Lemonade`.
2. Pick it. The status line shows `🍋 <model> (Lemonade)` while requests go to Lemonade.
3. To go back, pick any Claude model.

### In the desktop app

The desktop app's model picker lists only Claude models, so the 🍋 entry doesn't appear there. Use the model manager or the commands instead:

1. Type `/lemonade` and press **Use** on a model, or type `/lemonade on` to use the offered one. Every request now goes to Lemonade, subagents included. The picker keeps showing the Claude model it had.
2. To go back, press **Back to Claude**, type `/lemonade off`, or pick any model in the picker.

These work in the terminal too.

### The model manager

`/lemonade` with nothing after it draws a model list in the transcript:

- **Search** filters by name. **Downloaded only** hides models you'd have to download.
- **Active** lists models Lemonade has loaded in memory, marked with a green dot.
- **Downloaded** lists models on disk and ready to use.
- **Suggested** lists every other chat model Lemonade offers, in folders, as Lemonade's own model manager nests them:
  - First by recipe (Llama.cpp GPU, Ryzen AI LLM, …).
  - Then by maker (Qwen, Gemma, MiniCPM, …).
  - A maker with more than eight models opens onto family folders (Qwen3, Qwen3.5, Qwen3-VL, …).
  
  A folder shows how many models it holds and the sizes they span. A recipe's folder also says what it runs on (NVIDIA GPU, NPU…) and whether its backend is still to be installed. Every `/lemonade` starts with all folders closed. A model alone in its group is a row of its own. Press a folder to open it, and a search opens every folder down to what it finds.
- Each row lines up the model's name, size and tags (`tools`, `vision`, `reasoning`, `coding`), with sizes in the order people read them: 2B, 9B, 27B.
- **Use** switches requests to a downloaded model, as `/lemonade on <model>` does.
- **Download** asks Lemonade to download a model. Lemonade runs the download itself, so it keeps going if you close the session, and the row shows its progress. When it finishes, the model moves to **Downloaded**. A failed download says why, next to **Retry download**.

The list shows only chat models, the ones Claude Code can talk to. Lemonade's speech, image, music and embedding models stay in Lemonade's own app. So do models whose recipe Lemonade says this machine can't run.

### Commands

| Command | What it does |
| --- | --- |
| `/lemonade` | Opens the model manager |
| `/lemonade on` | Sends every request to the offered Lemonade model, whatever the model selector shows, until `/lemonade off` or you pick another model |
| `/lemonade on <model>` | Offers that model and switches to it |
| `/lemonade off` | Requests follow the model selector again |
| `/lemonade <model>` | Offers a downloaded model in the selector. It takes the exact id or any unique part of it, such as `/lemonade gemma` |
| `/lemonade list` | Lists the downloaded models, what the selector offers, and where requests go now |

Claude Code allows only one custom entry in the selector. LemonClaude offers the model you chose last time. The first time, it offers the first downloaded model that supports tool calling. If requests already go to Lemonade, choosing another model moves them to it at once.

### When Lemonade isn't running

The 🍋 entry still appears, offering the model from last time.

- **On Windows**, its description says Lemonade starts when picked. When a request is about to go to Lemonade and the server doesn't answer, LemonClaude starts it the way the Start menu shortcut does. A toast says "Starting Lemonade Server…", and LemonClaude waits up to 60 seconds before the request goes ahead. `/lemonade`, `/lemonade on` and `/lemonade <model>` start it too. `/lemonade list` and `/lemonade off` don't. The server keeps running after the session ends.
- **Elsewhere**, or when Lemonade Server isn't installed in the usual place, the description says to start Lemonade first.

If Lemonade still doesn't answer, a toast says so and suggests picking a Claude model.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `LEMONADE_BASE_URL` | `http://127.0.0.1:13305` | Where Lemonade Server listens |
| `LEMONCLAUDE_LEMONADE_MODEL` | `Qwen3.5-4B-GGUF` | The model to offer while Lemonade is down and no earlier choice is remembered |
| `LEMONCLAUDE_AUTOSTART` | on | Set to `0` so LemonClaude never starts Lemonade Server |
| `LEMONCLAUDE_CTX_SIZE` | `65536` | The context window LemonClaude loads models with, in tokens (at least 4096). 64K holds Claude Code's own prompt and tools, about 20–30K tokens, plus a conversation |
| `ANTHROPIC_CUSTOM_MODEL_OPTION` | none | If you've set this yourself for something other than Lemonade, LemonClaude leaves your entry alone |

### Privacy

While requests go to Lemonade, your prompts and code go to the server at `LEMONADE_BASE_URL`, by default on your own machine. Claude Code's own telemetry and update checks still follow your settings. Set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` to turn them off. LemonClaude works with that flag set. Some Claude Code versions (2.1.287) then refuse a mod's own network requests, and LemonClaude reaches Lemonade through `curl` instead.

## Sharing Lemonade with other apps

LemonClaude shares Lemonade Server with whatever else uses it, such as the Lemonade app, other Claude Code sessions or other mods. Lemonade is the one scheduler for your GPU, so LemonClaude follows a few rules to stay out of other apps' way:

- **It loads explicitly, with a bounded window.** Left to itself, Lemonade loads a model the moment a request names it, with its largest window. That can be 262K tokens, several gigabytes more than needed. LemonClaude loads its model first, with a 64K window (`LEMONCLAUDE_CTX_SIZE`). It only loads models already downloaded, because loading one that isn't would start a download.
- **It pins its model while in use, and unpins it when done.** A pinned model can't be evicted by another app's load. LemonClaude gives the pin back on `/lemonade off`, when you pick a Claude model or another Lemonade model, and when the session ends. The model stays loaded, warm for whoever needs it next.
- **It never touches what isn't its own.** LemonClaude remembers which models it pinned, and only ever unpins those. It never unloads a model and never changes Lemonade's settings. If a session crashes, the next one releases any pin it left after an hour unused.
- **It says exactly what happened.** If another app has pinned Lemonade's chat models, LemonClaude names them once: "Another app has pinned Lemonade's chat models (X), so Y can't load." It suggests unloading them in that app, raising Lemonade's `max_loaded_models`, or picking a Claude model. If loading made Lemonade unload another app's unpinned model, it says that too: "Lemonade unloaded X to make room."
- **It leaves other mods' agents alone.** A subagent of another plugin's agent type, one named like `other:worker`, is that plugin's to answer. LemonClaude passes its requests through untouched.

To run two chat models at once, raise `max_loaded_models` in Lemonade's settings. That's your call, so LemonClaude never changes it.

Another program, such as a second Lemonade server, can also hold GPU memory that this server can't see. On Windows a load into a full GPU doesn't fail. llama.cpp puts some layers in system RAM, or Windows pages GPU memory there, and the model answers slowly. So after each load, LemonClaude reads Windows' GPU counters for the process that runs the model and for its GPU:

- If much of the model is in system memory already, it says so: "About 1.5 GB of it is in system memory because the GPU is full, so it will be slow."
- If the model fits only because Windows paged an idle program out to make room, it says the GPU is overcommitted. That's when everything committed to the GPU is more than it has. When the programs on it are busy at once, Windows swaps them through system memory and they slow down.

Integrated GPUs, which borrow system memory by design, are left out. On other systems a load into a full GPU can fail outright, and LemonClaude then says "Not enough GPU memory: another app may be using it." Either way it suggests freeing GPU memory, lowering `LEMONCLAUDE_CTX_SIZE`, or picking a smaller model.

## How it works

- **The selector entry** comes from Claude Code's `ANTHROPIC_CUSTOM_MODEL_OPTION`, `_NAME` and `_DESCRIPTION` variables, which LemonClaude sets when the session starts.
- **Routing** happens in a `turn.step` hook that runs before every model request, main loop and subagents alike.
  - **A Lemonade model selected**, or `/lemonade on` holding: the hook makes sure the model is loaded and pinned (`/api/v1/load` with `ctx_size` and `pinned`, or `/internal/pin` when it's already loaded). Then it saves `ANTHROPIC_BASE_URL`, points it at Lemonade, and names the Lemonade model on the request. Claude Code reads that variable on every request, so the next one goes to Lemonade.
  - **A Claude model selected:** the hook restores the saved value and unpins the model it pinned.
  - **Another plugin's subagent:** the hook passes the request through untouched.
- **`/lemonade on`** records the model the session had when you typed it. When the session's model changes from that one, because you picked something in a picker, `/lemonade on` ends.
- **Model aliases:** unlike `lemonade launch claude`, LemonClaude leaves the `ANTHROPIC_DEFAULT_*_MODEL` aliases alone. Pointing them at Lemonade would make picking Opus resolve to the Lemonade model.
- **Starting Lemonade:** before each request to Lemonade, the hook checks the server's `/api/v1/health`. If the server doesn't answer, the hook runs `LemonadeServer.exe --silent` from `%LOCALAPPDATA%\lemonade_server\bin` through PowerShell's `Start-Process`. That detaches the server from Claude Code, so it outlives the session. LemonClaude only does this when `LEMONADE_BASE_URL` points at this machine. Requests that find the server down at the same time share one start.
- **The model manager** draws `/lemonade`'s output row as a tree of Claude Code UI elements. It reads Lemonade's catalog (`/api/v1/models?show_all=true`), what's loaded (`/api/v1/health`) and what this machine can run (`/api/v1/system-info`). Downloads use Lemonade's server-side download jobs (`/api/v1/pull`), and their progress is polled from `/api/v1/downloads` each second.
- **Session end:** the environment is also restored when the session ends, including on `/clear`.

## Known limitations

- **Desktop model picker:** the desktop app's picker lists only Claude models and doesn't show the 🍋 entry. Use `/lemonade` or `/lemonade on`. While requests go to Lemonade, the picker still names a Claude model.
- **`/model` with a full model id:** while requests go to Lemonade, Claude Code checks a typed id like `/model claude-sonnet-5-5` against Lemonade's model list, and it fails. Use the picker, an alias such as `/model sonnet`, or `/lemonade off`.
- **Disabling the mod:** pick a Claude model, or run `/lemonade off`, before you disable LemonClaude. Otherwise requests keep going to Lemonade until the session ends.
- **Selector refresh:** `/lemonade <model>` updates the entry at once, but a selector that caches its list may show the change only in a new session. `/model <id>` works right away.
- **Starting Lemonade:** only on Windows, and only with Lemonade Server installed by its Windows installer in `%LOCALAPPDATA%\lemonade_server`. LemonClaude never stops the server it starts.
- **Download size:** the model manager shows each model's size but doesn't check free disk space. If a download fails, Lemonade's reason shows in the row.
- **API keys:** a Lemonade server that requires `LEMONADE_API_KEY` isn't supported yet.
- **Context window:** Claude Code budgets context as if it were talking to Claude. The real limit is the window LemonClaude loads the model with, 64K by default (`LEMONCLAUDE_CTX_SIZE`). If another app already loaded the model with a different window, LemonClaude uses it as loaded rather than reload it.
- **Background calls:** Claude Code may print an `unrecognized_model` notice. Its background calls (session titles and similar) ask for Claude models, and Lemonade answers them with a 404 while requests go to Lemonade.
- **Model quality:** small local models follow Claude Code's tool protocol less reliably than Claude does. Models without the `tool-calling` label may fail to use tools at all.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/lemonade` is an unknown command | The mod isn't loaded: check `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS`, then start a new session |
| No 🍋 entry in the selector | In the desktop app that's expected: use `/lemonade on`. In the terminal, run `/lemonade list` to see what's offered |
| "Lemonade didn't answer" toast | Start Lemonade Server, or check `LEMONADE_BASE_URL` |
| "Lemonade Server didn't answer … within 60 s of starting" | Start Lemonade Server from the Start menu and check it runs. Its tray icon opens the logs |
| The first reply is slow | Loading a model takes a few seconds, and its first answer can take 20 seconds or more. `/lemonade on` loads before you ask anything |
| "Another app has pinned Lemonade's chat models (…)" | Another app holds Lemonade's chat slot. Unload its model there, raise `max_loaded_models` in Lemonade's settings, or pick a Claude model |
| "Not enough GPU memory", or "… is in system memory because the GPU is full" | Another program holds GPU memory. Free some, lower `LEMONCLAUDE_CTX_SIZE`, or pick a smaller model |
| "… isn't downloaded" | Download the model from `/lemonade` first. LemonClaude never downloads a model just by loading it |
| Tools fail or the model ignores them | Pick a model labeled `tool-calling` (the model manager shows `tools`) |
| Requests still go to Lemonade after removing the mod | Start a new session, or unset `ANTHROPIC_BASE_URL` in that shell |

## Development

```bash
claude plugin validate /path/to/LemonClaude
```

```bash
claude plugin test /path/to/LemonClaude
```

The code is in `hooks/register.tsx`, its state contract in `types/index.d.ts`, and its tests in `tests/lemonade.test.ts`. The tests run against a fake Lemonade, so they need no server, and they draw the model manager on both the terminal and desktop surfaces. The mod API is early access, so re-run `validate` and `test` after each Claude Code update.

Don't develop LemonClaude in a session that has it loaded. A bug in its `turn.step` hook would break that session's own requests. Test changes with `claude plugin test`, and live with `claude -p --plugin-dir` under a temporary `CLAUDE_CONFIG_DIR`.

## Future work

- **An embedded Lemonade per project**, as an opt-in. Two Lemonade servers on one GPU would each assume the whole card is free, so this only makes sense with each server given its own GPU.

## License

[MIT](LICENSE) © 2026 Adam Zhang
