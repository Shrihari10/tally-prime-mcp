// Runtime configuration for the Tally Prime XML/HTTP gateway.
//
// Tally exposes an XML-over-HTTP listener (default port 9000) once enabled in
// F1 (Help) > Settings > Connectivity > Client/Server configuration.

export interface TallyConfig {
  host: string;
  port: number;
  url: string;
  defaultCompany?: string;
  timeoutMs: number;
}

export function loadConfig(): TallyConfig {
  const host = process.env.TALLY_HOST?.trim() || "localhost";
  const port = Number.parseInt(process.env.TALLY_PORT?.trim() || "9000", 10);
  const defaultCompany = process.env.TALLY_COMPANY?.trim() || undefined;
  const timeoutMs = Number.parseInt(
    process.env.TALLY_TIMEOUT_MS?.trim() || "60000",
    10
  );

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(
      `Invalid TALLY_PORT: ${process.env.TALLY_PORT}. Expected an integer between 1 and 65535.`
    );
  }

  return {
    host,
    port,
    url: `http://${host}:${port}`,
    defaultCompany,
    timeoutMs: Number.isNaN(timeoutMs) ? 60000 : timeoutMs,
  };
}
