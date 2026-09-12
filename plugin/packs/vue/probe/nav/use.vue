<script lang="ts">
import { FriendlyGreeter, type Greeter } from './definitions.vue'

export function announce(greeter: Greeter, name: string): string {
  return greeter.greet(name)
}

export const message = announce(new FriendlyGreeter(), 'Ada')
</script>
