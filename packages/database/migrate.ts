import "dotenv/config";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./index";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migration");
try {
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, "drizzle") });
  console.log("Database migrations completed");
} finally {
  await pool.end();
}
