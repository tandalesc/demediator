import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// Prevent multiple connections during Next.js HMR in development
const globalForDb = globalThis as unknown as {
  pgClient: postgres.Sql | undefined;
};

const client = globalForDb.pgClient ?? postgres(connectionString);

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgClient = client;
}

export const db = drizzle(client, { schema });
