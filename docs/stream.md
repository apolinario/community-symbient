# The stream

A symbient's modules meet in one place: the stream, a single append-only file
of short natural-language entries. Perception writes what happened, inner life
writes what it thinks and wants, effectors write what they did. No module owns
another's output and none sits at the centre; each one reads the part of the
stream it is subscribed to.

This follows the Concurrent Modular Agent (Maruyama et al., 2025): modules that
run concurrently and coordinate through a shared global state rather than a
central hub.

## Entries

`workspace/stream.jsonl`, one entry per line:

```json
{"ts": 1793500000000, "category": "perception.sauna", "author": "sauna", "text": "The sauna is warming: 41°C, up 9° in the last hour."}
```

Categories are dotted paths, coarse to fine:

| family | examples | written by |
|---|---|---|
| `perception` | `perception.sauna`, `perception.chat.dm`, `perception.chat.group`, `perception.radio` | sensors, adapters, interpreter modules |
| `inner` | `inner.thought`, `inner.want`, `inner.dialogue` | inner-life modules |
| `effector` | `effector.said`, `effector.aired`, `effector.built` | effectors, recorded by the code that acts |
| `meta` | `meta.report`, `meta.self` | modules that watch the system |

A filter names a category or a whole branch: `perception.chat` matches
`perception.chat.dm` and `perception.chat.group`; `inner.want` matches only
itself and anything below it.

## Mediation

Modules never touch the file. They declare in frontmatter what they hear and
what they may say:

```yaml
reads: [perception, inner.want]
writes: [inner.thought]
```

The framework mediates both directions:

- **Hearing.** Each cycle, the module's prompt gets a `<stream>` block: the
  recent entries in its `reads` categories.
- **Saying.** A module with `writes` gets a `note` tool that accepts only those
  categories. A module with exactly one `writes` category has its final output
  recorded there when it wrote no notes that cycle.

Routing is visible in the frontmatter: who hears what can be read off the
module files, and filtering the stream by category is the debugging view.
Privacy is structural: a module that doesn't read `perception.chat.dm` never
sees a DM, however it is prompted.

## Roles

- **Perception** turns the world into entries: sensors, chat adapters, and small
  interpreter modules (cheap models are enough).
- **Inner life** is many small modules, each a single model call that reads a
  slice of the stream and writes one kind of entry.
- **Effectors** hold the tools that touch the world (messages, radio, code).
  They read wants and context from the stream and record what they did.
- **Meta** modules read the whole stream to report on the system, write the
  autobiographical self, and adjust rhythms.

The daily markdown logs and `MEMORY.md` become views derived from the stream,
not inputs every module carries.
