import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { ENV } from "./env.server";

const app = new Hono();

app.use(logger());
app.use(
  "/*",
  cors({
    allowMethods: ["GET", "POST", "OPTIONS"],
    origin: ENV.CORS_ORIGIN,
  })
);

app.get("/", (c) => c.text("OK"));

export default app;
