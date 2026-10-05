import { createApp } from "./app.ts";
import { runtimeConfig } from "./config.ts";
import { startCompatibilityUpdates } from "./runtime.ts";

const { port, host, dataDir } = runtimeConfig();
process.env.EQUIP_DATA_DIR = dataDir;
const { app, close } = await createApp({ dataDir });
let stopCompatibilityUpdates: () => void;
try {
  stopCompatibilityUpdates = await startCompatibilityUpdates(dataDir);
} catch (error) {
  await close();
  throw error;
}
const server = app.listen(port, host, () =>
  console.log(`Equip server listening at http://${host}:${port}`),
);
const shutdown = () =>
  server.close(() => {
    stopCompatibilityUpdates();
    void close().then(() => process.exit(0));
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
