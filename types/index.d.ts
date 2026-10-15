export type Busy = boolean

declare module 'claude-code' {
  interface PluginState {
    'optimize-prompt': { isBusy: Busy; frame: number }
  }
}
