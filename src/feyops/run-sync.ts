import { syncAmenitiz } from "./sync.js";
import { FeyOpsDB } from "./db.js";

const db = new FeyOpsDB("./data/feyops.db");
const result = await syncAmenitiz(db);
console.log("Sync result:", JSON.stringify(result));
