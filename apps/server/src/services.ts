import { type Database, createDb } from "@portfolio-cf/db";

import { ENV } from "./env.server";

export function getDb(): Database {
  return createDb(ENV);
}
