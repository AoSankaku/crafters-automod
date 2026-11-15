/** Node mirrors the documented .env loading while explicit environment values win. */
export function loadEnvironment() {
  if (process.versions.bun) return;
  try {
    process.loadEnvFile(".env");
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Unable to load the environment file.");
  }
}
