# LemonClaude

A Claude Code mod (function-hooks plugin) that adds Lemonade local models as a switchable option. Read README.md first. Load the `plugin-authoring` skill before changing `hooks/register.tsx`, and treat its `claude-code.d.ts` as the authority.

## Rules

- No AI authorship. Commits, docs and releases credit only Adam Zhang (`-c user.name=adamczhang -c user.email=adam.dadvibes@gmail.com`). Never add a `Co-Authored-By: Claude` trailer or a "Generated with Claude Code" line.
- Ask before downloads or installs, and before changing the owner's real Claude Code profile (`D:\ClaudeHome`). For experiments, use a temporary `CLAUDE_CONFIG_DIR` with a dummy `ANTHROPIC_API_KEY`.
- Don't push without the owner's word.
- Don't hot-load this mod into the session that develops it: a bug in its `turn.step` hook would break that session's own requests. Test with `claude plugin test` and with `claude -p --plugin-dir` under a temp config.
