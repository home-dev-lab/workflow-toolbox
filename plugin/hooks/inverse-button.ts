import type { ClientModule } from 'claude-code'

// A clickable inverse button: the surface draws its own dark-on-light label
// and reports a completed left click to the hooks module.
type Props = { label: string; fg: string; bg: string }
type State = { down: boolean }

const InverseButton: ClientModule<Props, State> = (props, surface) => {
  if (surface.state === undefined) {
    surface.onPointer(event => {
      if (event.type === 'down' && event.button === 'left') surface.setState({ down: true })
      else if (event.type === 'up' && surface.state?.down) {
        const inside = event.x >= 0 && event.y >= 0 && event.x < surface.columns && event.y < surface.rows
        surface.setState({ down: false })
        if (inside) surface.post({ pressed: true })
      }
    })
    surface.setState({ down: false })
  }
  const down = surface.state?.down ?? false
  const { Text } = surface.elements as { Text: (props: Record<string, unknown>) => ReturnType<ClientModule> }
  // Pressed: the luminance flips, so the press is visible without relying on hue.
  return Text({ children: props.label, wrap: 'wrap', color: down ? props.bg : props.fg, backgroundColor: down ? props.fg : props.bg, bold: true })
}
export default InverseButton
