/**
 * Vercel entrypoint. Vercel's Node.js builder treats a default-exported
 * Express app as a request handler automatically — no listen() call needed,
 * and no extra adapter package required.
 *
 * Requires TOKEN_STORE_DRIVER=kv (see ../README.md) since Vercel Functions
 * have no persistent filesystem between invocations.
 */
import { app } from "../src/app.js";

export default app;
