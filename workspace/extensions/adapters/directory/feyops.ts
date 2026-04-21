/**
 * Registers the FeyOps directory adapter for the Feÿ deployment.
 *
 * The framework's extension loader auto-imports every .js/.ts file in
 * `workspace/extensions/adapters/directory/` at startup, BEFORE resolving
 * `config.adapters.directory`. Importing `../../../services/feyops/db.js`
 * fires its `registerDirectory(feyOpsDirectoryFactory)` side-effect, so
 * when the framework looks up adapter "feyops", it's found.
 */

export { feyOpsDirectoryFactory as default } from "../../../services/feyops/db.js";
