import { FriendlyGreeter, Greeter } from './definitions'

export function announce(greeter: Greeter, name: string): string {
  return greeter.greet(name)
}

export const message = announce(new FriendlyGreeter(), 'Ada')
