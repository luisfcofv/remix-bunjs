import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dbName, getDrizzle } from "./app/db";
import Database from "bun:sqlite";

using db = new Database(dbName);
const drizzle = getDrizzle(db);
await migrate(drizzle, { migrationsFolder: "./drizzle" });
