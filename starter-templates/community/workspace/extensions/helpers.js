/**
 * Custom Handlebars helpers — available in every module's .md template.
 *
 * Built-in helpers (always available): currentTime, currentDate,
 * currentDateTime, dayOfWeek, memoryContext, innerState, currentDesire,
 * currentMagi, soul.
 *
 * Add deployment-specific helpers here. They'll be available as
 * `{{yourHelperName}}` in any workspace/modules/*.md template.
 *
 * Helpers can be sync or async. They receive (ctx, ...args) — ctx is the
 * calling module's ModuleContext (undefined if called outside a cycle).
 */

export default {
  // Example — expose current weather in prompts as {{weather}}
  //
  // weather: async () => {
  //   const r = await fetch("https://api.openweathermap.org/...");
  //   const data = await r.json();
  //   return `${data.main.temp}°C, ${data.weather[0].description}`;
  // },
};
