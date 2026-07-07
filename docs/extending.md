# Extending the framework

All customization lives in `workspace/extensions/` — core `src/` never
needs editing, which is what keeps upgrades merge-free (see
[upgrading](upgrading.md)). At boot the framework imports these files if
present and registers their exports; every one is optional.

| File | Export shape | Registers |
|---|---|---|
| `helpers.ts` | named functions | Handlebars template vars for module prompts |
| `providers.ts` | objects with `execute()` | context providers for `context:` frontmatter |
| `handlers.js` | functions keyed by module name | module output handlers |
| `actions.ts` | action handlers | watch action kinds (beyond built-in dm/group/nudge) |
| `adapters/chat/*.ts` | factory functions | chat transports (Matrix, Discord, …) |
| `adapters/directory/*.ts` | factory functions | person/directory backends |
| `sensors/*.ts` | factory functions | sensors |
| `tools.ts` | default export `(deps) => AgentTool[]` | deployment tools |
| `modules.ts` | setup function | code-driven modules and service wiring |

Minimal examples:

```ts
// workspace/extensions/helpers.ts
export function moonPhase() {
  return computePhase(new Date());   // available as {{moonPhase}} in any module
}
```

```ts
// workspace/extensions/providers.ts
export const weather = {
  execute: async () => ({ tag: "weather", content: await fetchLocalWeather() }),
};
// modules opt in with:  context: [{ source: weather }]
```

```ts
// workspace/extensions/tools.ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
export default function myTools(deps): AgentTool[] {
  return [/* Type.Object-parameterized tools; see workspace/services/ for real ones */];
}
```

The contracts live in `src/core/extension-loader.ts`; the Feÿ deployment's
own extensions in this repo are the reference implementations.

Tool tips: parameters use TypeBox (`Type` from `@mariozechner/pi-ai`) — the
same schema language the config validator uses. Return
`{ content: [{ type: "text", text }], details: {} }`.
