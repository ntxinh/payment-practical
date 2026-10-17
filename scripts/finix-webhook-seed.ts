import { appUrl } from "@/server/env";
import { finixRequest, getFinix } from "@/server/modules/billing/finix";

const finix = getFinix();
const res = await finixRequest(finix, "POST", "/webhooks", {
  url: `${appUrl()}/api/v1/webhooks/finix`,
  enabled: true,
});
console.log("webhook:", res.id ?? res);
console.log("secret:", res.authentication_secret ?? res.secret ?? "(see response)");
console.log(
  `set FINIX_WEBHOOK_SECRET=<secret> in .env — endpoint: ${appUrl()}/api/v1/webhooks/finix`,
);
