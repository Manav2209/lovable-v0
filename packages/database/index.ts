import 'dotenv/config';
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index"



// Create connection pool
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
});

// Initialize Drizzle ORM
export const db = drizzle(pool, { schema });
