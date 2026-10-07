import type { ClientModule, Register } from 'claude-code'
import { registerWithLayout, WORKFLOW_TOOLBOX_LAYOUT } from './hooks.js'

type ButtonProps = { label: string; fg: string; bg: string }
type ButtonUI = { Client: (props: { key: string; module: string; props: ButtonProps }) => ReturnType<ClientModule> }

// The host discovers Client modules from a literal module attribute in JSX.
// Its resolved component bundle is supplied at render time.
function clientButton(ui: ButtonUI, key: string, label: string, fg: string, bg: string) {
  const { Client } = ui
  return <Client key={key} module="./inverse-button.ts" props={{ label, fg, bg }} />
}

export const register: Register = (on, options) => registerWithLayout(on, options, WORKFLOW_TOOLBOX_LAYOUT, clientButton)
