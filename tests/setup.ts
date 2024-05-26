import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { dbTest } from "./db";

await migrate(dbTest, { migrationsFolder: "./drizzle" });
console.log("Database migrated");
