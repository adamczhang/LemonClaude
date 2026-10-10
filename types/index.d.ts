/** A chat model Lemonade lists, downloaded or one it suggests. */
export type LemonadeModel = {
  id: string
  /** Download size in GB, as Lemonade reports it. */
  size?: number
  labels: string[]
  /** The Lemonade recipe that runs it, such as `llamacpp`; its model manager groups by it. */
  recipe: string
  /** True once it is downloaded and can serve requests. */
  isDownloaded: boolean
  /** True when Lemonade lists it with the `tool-calling` label. */
  hasTools: boolean
  /** True while Lemonade has it loaded in memory. */
  isLoaded: boolean
  /** The largest context window it holds, in tokens, as Lemonade knows it. */
  maxWindow?: number
  /** While loaded, the window it is loaded with, in tokens. */
  window?: number
  /** A collection's models (an Omni model's), by id. */
  components?: string[]
  /** True when it is too big for the memory its recipe runs in on this machine. */
  isTooBig?: boolean
  /** Who pinned it, while it is loaded and pinned: LemonClaude (`mine`) or another app (`theirs`). */
  pin?: 'mine' | 'theirs'
}

/** A model download Lemonade runs on the server, as `/api/v1/downloads` reports it. */
export type DownloadState = {
  percent: number
  /** `starting` (asked, Lemonade not yet listing it), `downloading`, `paused` or `error`. */
  status: string
  error?: string
}

/** Where a Lemonade recipe runs by default (`NPU`, `NVIDIA GPU`), and whether that backend is installed. */
export type Recipe = {
  device: string
  isInstalled: boolean
  /** The memory its models run in, in GB: a discrete GPU's own, or the system's. */
  memoryGb?: number
  /** True when that is system memory, shared with everything else. */
  isShared?: boolean
}

/** The environment as it was before requests went to Lemonade, restored when they stop. */
export type SavedEnv = {
  ANTHROPIC_BASE_URL: string | null
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: string | null
  /** Absent in an environment saved by an earlier version. */
  CLAUDE_CODE_MAX_CONTEXT_TOKENS?: string | null
}

declare module 'claude-code' {
  interface PluginState {
    lemonclaude: {
      /** The Lemonade model the model selector offers, or null when none is offered. */
      offered: string | null
      /** The Lemonade model requests go to now, or null while Claude answers. */
      routed: string | null
      saved: SavedEnv | null
      notice: string
      /**
       * While /lemonade on holds, the session model it holds over, else null: every request goes to the
       * offered model until the session's model changes from this one or /lemonade off.
       */
      heldOver: string | null
      /** Every chat model Lemonade lists, downloaded or suggested, by name. */
      catalog: LemonadeModel[]
      /** Downloads under way, by model id. */
      downloads: Record<string, DownloadState>
      /** What the model list's search box holds. */
      search: string
      /** True while the model list shows downloaded models only. */
      isDownloadedOnly: boolean
      /** The folders the model list has open; every /lemonade starts with none. */
      expanded: string[]
      /** True while the model list shows suggested models too big for this machine. */
      isTooBigShown: boolean
      /** Each recipe's default device and backend state, as /api/v1/system-info says. */
      recipes: Record<string, Recipe>
    }
  }
}
