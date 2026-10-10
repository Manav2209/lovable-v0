import "dotenv/config";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for migration");
// DDL on a remote database can take longer than an ordinary API query.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10_000,
  query_timeout: 60_000,
});
const db = drizzle(pool);
try {
  await migrate(db, { migrationsFolder: resolve(import.meta.dir, "drizzle") });
  console.log("Database migrations completed");
} finally {
  await pool.end();
}
