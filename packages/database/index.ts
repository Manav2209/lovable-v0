import 'dotenv/config';
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index"


// Create connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL!,
});

// Initialize Drizzle ORM
export const db = drizzle(pool, { schema });


console.log('✅ Database connected successfully!');


