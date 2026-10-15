/* global globalThis */
import mongoose from "mongoose";

// One connection per server process. The promise is kept on globalThis so
// Vite's dev-server module reloads don't open a new pool on every edit.
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
export const MONGODB_DB = process.env.MONGODB_DB || "protocol_rx";

mongoose.set("strictQuery", true);

export function connectDb() {
  if (!globalThis.__rxMongo) {
    globalThis.__rxMongo = mongoose
      .connect(MONGODB_URI, {
        dbName: MONGODB_DB,
        maxPoolSize: Number(process.env.MONGODB_POOL_SIZE || 20),
        // The database is a remote server: when its connection drops
        // ("connection <monitor> ... closed") the driver reconnects by itself -
        // give a request up to 30 s to wait for that instead of failing at 8 s.
        serverSelectionTimeoutMS: 30000,
        // Close idle sockets before a firewall / the server silently kills
        // them, so a request never picks up a dead one.
        maxIdleTimeMS: 60000,
        // IPv4 straight away (no slow IPv6 attempt first on Windows).
        family: 4,
      })
      .catch((err) => {
        // Let the next request retry instead of caching a dead connection.
        globalThis.__rxMongo = null;
        throw err;
      });
  }
  return globalThis.__rxMongo;
}

export { MONGODB_URI };
export default mongoose;
