// Writes the exercise tuples to Auth0 FGA. Secrets come from the environment
// and are never printed. Dry-run prints the tuple keys only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeSub, ragConfig, writeTuples } from "../src/rag/fga.js";

const tupleFile = fileURLToPath(new URL("../fga/tuples.example.json", import.meta.url));
const USER = /^(user:\*|user:[A-Za-z0-9_|.:@-]{1,128}|folder:[a-z0-9-]{1,64})$/;
const OBJECT = /^(folder|document):[a-z0-9-]{1,64}$/;
const RELATION = /^(viewer|parent|owner)$/;

export function buildTuples(coordinatorSub, file = tupleFile) {
  const sub = normalizeSub(coordinatorSub);
  if (!sub) throw new Error("COORDINATOR_SUB");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(raw?.writes)) throw new Error("TUPLE_FILE");
  const tuples = raw.writes.map(tuple => ({
    user: String(tuple.user || "").replaceAll("{{COORDINATOR_SUB}}", sub),
    relation: tuple.relation,
    object: tuple.object
  }));
  for (const tuple of tuples) {
    if (!USER.test(tuple.user) || !RELATION.test(tuple.relation) || !OBJECT.test(tuple.object) || JSON.stringify(tuple).includes("{{")) {
      throw new Error("TUPLE_SHAPE");
    }
  }
  return tuples;
}
function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}
async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let tuples;
  try {
    tuples = buildTuples(process.env.COORDINATOR_SUB);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "TUPLE_ERROR");
    process.exit(1);
  }
  if (dryRun) {
    console.log(JSON.stringify(tuples, null, 2));
    return;
  }
  const config = ragConfig(process.env);
  if (!config.enabled) {
    console.error("FGA is not configured. Set FGA_STORE_ID, FGA_CLIENT_ID and FGA_CLIENT_SECRET. RAG_AGENT=off also disables the write.");
    process.exit(1);
  }
  try {
    const result = await writeTuples(config, tuples, fetch);
    console.log("Wrote " + result.count + " tuples.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "FGA_WRITE");
    process.exit(1);
  }
}
if (isDirectRun()) await main();
