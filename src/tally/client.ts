// Thin HTTP client around the Tally Prime XML gateway.

import { request } from "undici";
import { loadConfig, TallyConfig } from "./config.js";
import { isFailureEnvelope, parseTallyXml } from "./xml.js";

export class TallyClient {
  constructor(public readonly config: TallyConfig = loadConfig()) {}

  /** POST a Tally XML envelope and return the raw response body. */
  async send(xml: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await request(this.config.url, {
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          "Content-Length": Buffer.byteLength(xml, "utf8").toString(),
        },
        body: xml,
        signal: controller.signal,
      });
      const body = await res.body.text();
      if (res.statusCode >= 400) {
        throw new Error(
          `Tally HTTP ${res.statusCode}: ${body.slice(0, 500)}`
        );
      }
      const failure = isFailureEnvelope(body);
      if (failure.failed) {
        throw new Error(
          `Tally returned failure status` +
            (failure.reason ? `: ${failure.reason}` : "")
        );
      }
      return body;
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new Error(
          `Tally request timed out after ${this.config.timeoutMs}ms (host ${this.config.url}).`
        );
      }
      // Friendly hint for the most common failure: gateway not enabled.
      if (
        err?.code === "ECONNREFUSED" ||
        err?.cause?.code === "ECONNREFUSED"
      ) {
        throw new Error(
          `Could not connect to Tally at ${this.config.url}. ` +
            `Open Tally Prime, then F1 (Help) > Settings > Connectivity > Client/Server configuration. ` +
            `Set "TallyPrime acts as = Both / Server" and Port = ${this.config.port}.`
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Convenience: send + parse to JS object. */
  async sendAndParse(xml: string): Promise<any> {
    const body = await this.send(xml);
    return parseTallyXml(body);
  }
}
