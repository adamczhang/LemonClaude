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

/** The environment as it was before requests went to Lemonade, restored when they stop. */
export type SavedEnv = {
  ANTHROPIC_BASE_URL: string | null
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string | null
}

declare module 'claude-code' {
  interface PluginState {
    lemonclaude: {
      /** The Lemonade model the model selector offers, or null when none is offered. */
      offered: string | null
      /** The Lemonade model requests go to now, or null while Claude answers. */
      routed: string | null
      saved: SavedEnv | null
      models: LemonadeModel[]
      notice: string
      /** True while /lemonade on sends every request to the offered model, whatever the session's model. */
      isOn: boolean
    }
  }
}
