import { createDb } from "@portfolio-cf/db";
import type { Database } from "@portfolio-cf/db";

import { ENV } from "./env.server";

export function getDb(): Database {
  return createDb(ENV.DB);
}
