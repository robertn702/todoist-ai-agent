import { harnessCallbackHandler } from "./handler.ts";
import { withSentry } from "../_shared/sentry.ts";
import { validateEnv, validateEncryptionKey } from "../_shared/env.ts";

validateEnv(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
validateEncryptionKey();

Deno.serve(withSentry(harnessCallbackHandler));
