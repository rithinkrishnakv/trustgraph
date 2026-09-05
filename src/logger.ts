import pino from "pino";
import { config } from "./config.js";

// GUARDRAIL: redact paths cover every place a token/credential/authorization
// header could plausibly end up in a logged object, per the spec's explicit
// "do not leak credentials, tokens, or secrets into logs/errors" requirement.
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      "githubToken",
      "*.githubToken",
      "authorization",
      "*.authorization",
      "headers.authorization",
      "req.headers.authorization",
      "*.token",
      "*.secret",
      "*.password",
      "*.apiKey",
    ],
    censor: "[REDACTED]",
  },
});
