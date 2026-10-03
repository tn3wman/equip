import { createApp } from "./app.ts";
import { runtimeConfig } from "./config.ts";
import { startCompatibilityUpdates } from "./runtime.ts";

const { port, host, dataDir } = runtimeConfig();
process.env.EQUIP_DATA_DIR = dataDir;
const stopCompatibilityUpdates = await startCompatibilityUpdates(dataDir);
const { app, close } = createApp({ dataDir });
const server = app.listen(port, host, () =>
  console.log(`Equip server listening at http://${host}:${port}`),
);
const shutdown = () =>
  server.close(() => {
    stopCompatibilityUpdates();
    close();
    process.exit(0);
  });
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
