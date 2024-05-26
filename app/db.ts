import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Database } from "bun:sqlite";
import * as schema from "../db/schema";

export const dbName = "sqlite.db";

export const getDrizzle = (db: Database) => {
  return drizzle(db, { schema });
};
