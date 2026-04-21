/**
 * Custom watch action kinds — fire when a matching event arrives.
 *
 * Built-in actions: dm, group, nudge.
 *
 * Each export keyed by action kind. Receives
 * { params, messages, event, watchId } — params is the full action object
 * from watches.json (minus `kind`), messages is the evaluator's MessageClient
 * (for nudging modules), event is the triggering event, watchId identifies
 * the watch.
 */

export default {
  // Example — POST to a webhook when a watch fires:
  //
  // webhook: async ({ params, event, watchId }) => {
  //   await fetch(params.url, {
  //     method: "POST",
  //     headers: { "content-type": "application/json" },
  //     body: JSON.stringify({ watchId, event, ...(params.payload ?? {}) }),
  //   });
  // },
  //
  // Example — ask the executive module to deliberate before acting:
  //
  // review: async ({ params, messages, event, watchId }) => {
  //   await messages.send("executive", `review_trigger:${JSON.stringify({
  //     watchId, event, prompt: params.prompt,
  //   })}`);
  // },
};
