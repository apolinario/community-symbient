/**
 * Custom context providers — populate the seed prompt of any module by
 * declaring `context: - source: <name>` in the module's frontmatter.
 *
 * Built-in providers: events, current-time, most-played-songs,
 * upcoming-scheduled, active-threads, house-status.
 *
 * Each provider is `{ execute: async (decl, ctx) => string | null }`.
 * decl is the full YAML object from the module's frontmatter (minus
 * `source`) so your provider can read parameters.
 *
 * Since event types are open, a custom PROVIDER is only needed when you
 * want a non-trivial transformation (aggregation, sort, join). For
 * simple "last N events of type X", just use the built-in `events`
 * provider — a new event type needs no new code.
 */

export default {
  // Example — a weather-forecast provider that fetches live forecast
  // and formats it as a block. Declared in frontmatter as:
  //
  //   context:
  //     - source: weather-forecast
  //       days: 3
  //       tag: weather
  //
  // "weather-forecast": {
  //   execute: async (decl) => {
  //     const days = decl.days ?? 3;
  //     const r = await fetch(`https://api.example.com/forecast?days=${days}`);
  //     const data = await r.json();
  //     return data.forecast.map(d => `${d.date}: ${d.summary}`).join("\n");
  //   },
  // },
};
