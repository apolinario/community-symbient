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

Modules never touch the file. Like every other context, what a module hears is
declared in its frontmatter and built fresh each cycle; what it may say is
declared next to its tools:

```yaml
tools: [radio_say, radio_play, radio_status]
writes: [effector.aired]
context:
  - source: current-time
  - source: stream
    categories: [perception.radio, perception.sauna, inner.want]
    limit: 30
```

- **Hearing.** The `stream` provider renders the most recent `limit` entries
  (default 40) in the given `categories`. A module can declare several slices,
  each with its own `tag`.
- **Saying.** A module with `writes` gets a `note` tool that accepts only those
  categories. A module with exactly one `writes` category has its final output
  recorded there when it wrote no notes that cycle.

The frontmatter says everything about a module: what it hears (`context`), what
it can do (`tools`), what it can say (`writes`). Filtering the stream by
category is the debugging view. Privacy is structural: a module without a
slice that includes `perception.chat.dm` never hears a DM, however it is
prompted.

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
