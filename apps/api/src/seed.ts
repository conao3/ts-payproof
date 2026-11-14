import { MongoClient } from "mongodb"
import * as z from "zod"
import { initializeDatabase, seedDatabase } from "./store.ts"
const config = z
  .object({ MONGODB_URI: z.string().min(1), MONGODB_DB: z.string().min(1) })
  .parse(process.env)
const client = new MongoClient(config.MONGODB_URI)
await client.connect()
try {
  const db = client.db(config.MONGODB_DB)
  await initializeDatabase(db)
  await seedDatabase(db)
  console.log("Synthetic suppliers and demo principals are ready")
} finally {
  await client.close()
}
