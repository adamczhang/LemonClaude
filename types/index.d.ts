/** A model the Lemonade server has downloaded and can serve for chat. */
export type LemonadeModel = {
  id: string
  /** Download size in GB, as Lemonade reports it. */
  size?: number
  labels: string[]
  /** True when Lemonade lists it with the `tool-calling` label. */
  hasTools: boolean
  /** True while Lemonade has it loaded in memory. */
  isLoaded: boolean
}

/** The session's routing while Lemonade answers in place of Claude. */
export type Active = {
  model: string
  baseUrl: string
  hasTools: boolean
}

/** The environment as it was before the switch, restored by `/lemonade off`. */
export type SavedEnv = {
  ANTHROPIC_BASE_URL: string | null
  ANTHROPIC_DEFAULT_OPUS_MODEL: string | null
  ANTHROPIC_DEFAULT_SONNET_MODEL: string | null
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string | null
  CLAUDE_CODE_SUBAGENT_MODEL: string | null
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string | null
}

declare module 'claude-code' {
  interface PluginState {
    sidekick: {
      active: Active | null
      saved: SavedEnv | null
      models: LemonadeModel[]
      notice: string
    }
  }
}
