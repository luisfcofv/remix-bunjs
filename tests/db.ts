import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import * as schema from "../db/schema";

export const sqliteTest = new Database(":memory:");
export const dbTest = drizzle(sqliteTest, { schema });
