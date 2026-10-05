import path from "node:path";

type Environment = Record<string, string | undefined>;

export function runtimeConfig(environment: Environment = process.env) {
  const railway = Boolean(environment.RAILWAY_ENVIRONMENT_ID);
  return {
    host: environment.HOST || (railway ? "0.0.0.0" : "127.0.0.1"),
    port: Number(environment.PORT ?? 4310),
    dataDir:
      environment.EQUIP_DATA_DIR ||
      environment.RAILWAY_VOLUME_MOUNT_PATH ||
      path.resolve(".equip-data"),
  };
}

export function configuredPublicUrl(
  explicit: string | undefined,
  environment: Environment = process.env,
) {
  if (explicit) return explicit;
  if (environment.EQUIP_PUBLIC_URL) return environment.EQUIP_PUBLIC_URL;
  if (environment.RAILWAY_PUBLIC_DOMAIN)
    return `https://${environment.RAILWAY_PUBLIC_DOMAIN}`;
  return undefined;
}
