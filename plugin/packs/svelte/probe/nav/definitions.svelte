<script lang="ts">
  export let greeting = 'Hello'

  export function greet(name: string): string {
    return `${greeting}, ${name}`
  }
</script>

<h1>{greet('Ada')}</h1>
