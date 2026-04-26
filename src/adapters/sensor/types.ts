/**
 * Sensor — pluggable input source.
 *
 * A sensor polls some external signal and produces structured events via
 * `recordEvent()`. Examples:
 *   - HTTP sensors (weather APIs, door-lock status, IoT endpoints)
 *   - MQTT sensors (home-automation topics)
 *   - Spreadsheet sensors (a shared sheet acting as a sensor log)
 *   - File sensors (watching a log file for new lines)
 *   - Arbitrary JS sensors in workspace/extensions/sensors/*.js
 *
 * The framework provides a registry + config-driven instantiation. A
 * sensor's job is narrow: poll, emit events. Context providers and
 * watches consume those events — the sensor doesn't care what happens
 * downstream.
 */

export interface Sensor {
  /** Stable id — referenced from config.yaml and used in event.source fields. */
  readonly id: string;

  /** Display name for logs. Defaults to id. */
  readonly name?: string;

  /**
   * Poll the external source once. Record any new events via `recordEvent`
   * from `src/core/event-log.js`. Errors should be caught and logged —
   * the orchestrator retries on the next interval.
   */
  poll(): Promise<void>;
}

export interface SensorFactory {
  /** Adapter name referenced by `adapter:` in config.yaml. */
  name: string;
  /** Construct a sensor instance with config-provided params. */
  create(params: Record<string, unknown>): Sensor;
}
