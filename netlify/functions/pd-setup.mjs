/* ============================================================
   ONE-TIME Pipedrive setup (run once, then it's idempotent).
   Creates all custom fields on Persons and Deals plus the
   portal-access webhook, and returns the field-key map to put
   into Netlify env vars.

   Call:  GET /.netlify/functions/pd-setup?secret=<PD_SETUP_SECRET>
   Env:   PIPEDRIVE_API_TOKEN, PD_SETUP_SECRET, PD_WEBHOOK_SECRET, URL (Netlify-provided)
   ============================================================ */

const API = "https://api.pipedrive.com/v1";

const PERSON_FIELDS = [
  { name: "Preferred Name", field_type: "varchar" },
  { name: "State of Residence", field_type: "varchar" },
  { name: "Role", field_type: "varchar" },
  { name: "Marital Status", field_type: "varchar" },
  { name: "Household Income", field_type: "varchar" },
  { name: "Net Worth", field_type: "varchar" },
  { name: "DST Familiarity", field_type: "varchar" },
  { name: "Current Plan", field_type: "varchar" },
  { name: "US Check", field_type: "varchar" },
  { name: "Accreditation Check", field_type: "varchar" },
  { name: "Portal Access", field_type: "enum", options: ["Yes", "No"] },
  { name: "CRS Delivery Date", field_type: "date" }
];

const DEAL_FIELDS = [
  { name: "Situation", field_type: "varchar" },
  { name: "Closing Date", field_type: "date" },
  { name: "Equity", field_type: "monetary" },
  { name: "Debt", field_type: "monetary" },
  { name: "Anticipated Investment", field_type: "monetary" },
  { name: "In-Place LTV %", field_type: "double" },
  { name: "Total Investment Size", field_type: "monetary" },
  { name: "45-Day Deadline", field_type: "date" },
  { name: "180-Day Deadline", field_type: "date" },
  { name: "Routed To", field_type: "varchar" }
];

export default async (req) => {
  const url = new URL(req.url);
  if (!process.env.PD_SETUP_SECRET || url.searchParams.get("secret") !== process.env.PD_SETUP_SECRET) {
    return json({ error: "unauthorized" }, 401);
  }
  const token = process.env.PIPEDRIVE_API_TOKEN;
  if (!token) return json({ error: "PIPEDRIVE_API_TOKEN not set" }, 503);

  const out = { person: {}, deal: {}, portal_yes_option_id: null, webhook: null };

  for (const [kind, defs] of [["personFields", PERSON_FIELDS], ["dealFields", DEAL_FIELDS]]) {
    const existing = await pd(`GET`, `/${kind}`, token);
    const byName = new Map((existing.data || []).map((f) => [f.name.toLowerCase(), f]));
    for (const def of defs) {
      let field = byName.get(def.name.toLowerCase());
      if (!field) {
        const body = { name: def.name, field_type: def.field_type };
        if (def.options) body.options = def.options.map((label) => ({ label }));
        const created = await pd(`POST`, `/${kind}`, token, body);
        field = created.data;
      }
      const bucket = kind === "personFields" ? out.person : out.deal;
      bucket[def.name] = field.key;
      if (def.name === "Portal Access") {
        const yes = (field.options || []).find((o) => /^yes$/i.test(o.label));
        out.portal_yes_option_id = yes ? yes.id : null;
      }
    }
  }

  // Webhook: person updates → portal sync function
  const site = process.env.URL || "https://streamlined-baker-1031.netlify.app";
  const hookUrl = `${site}/.netlify/functions/pipedrive-portal-sync?secret=${process.env.PD_WEBHOOK_SECRET || "SET-PD_WEBHOOK_SECRET"}`;
  const hooks = await pd(`GET`, `/webhooks`, token);
  const already = (hooks.data || []).find((w) => w.subscription_url === hookUrl && w.event_object === "person");
  if (already) {
    out.webhook = { id: already.id, note: "already existed" };
  } else {
    const hook = await pd(`POST`, `/webhooks`, token, {
      subscription_url: hookUrl,
      event_action: "updated",
      event_object: "person",
      version: "2.0"
    });
    out.webhook = hook.data ? { id: hook.data.id } : { error: hook };
  }

  out.env_vars_to_set = {
    PD_FIELD_PORTAL_ACCESS: out.person["Portal Access"],
    PD_PORTAL_YES: String(out.portal_yes_option_id),
    PD_FIELD_CRS_DELIVERY: out.person["CRS Delivery Date"]
  };
  return json(out);
};

async function pd(method, path, token, body) {
  const res = await fetch(`${API}${path}?api_token=${token}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return res.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
