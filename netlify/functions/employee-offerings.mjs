/* ============================================================
   Employee portfolio-builder data proxy.

   GET /.netlify/functions/employee-offerings

   Returns the raw "Identity & Offering" records (selected fields) from
   Airtable so /employee.html can build portfolios from LIVE statuses and
   available equity — fresher than data/offerings.json, which is only as
   current as the last site build. Uses the same AIRTABLE_TOKEN env var
   as the build (read scope is all it needs).

   Read-only. CDN-cached for 5 minutes so a day of employee use costs a
   handful of Airtable calls. The page itself sits behind the team
   password; the fields returned here all also appear on the public
   offering pages, so this endpoint exposes nothing new.
   ============================================================ */

const BASE_ID = "appjKrPkYahBOgE5Q";
const TABLE_ID = "tbl3R1WFUkaPLtxPV"; // Identity & Offering

const FIELDS = [
  "Investment Name", "Sponsor", "Status", "Equity", "Debt", "In-Place LTV",
  "Available Equity", "Minimum Investment", "Y1", "Average Yield", "Peak - Deal",
  "721 Exchange Exit", "Property Type", "Location (Use)", "URL", "Strategy",
  "Structure", "Connected REIT", "Last Updated"
];

export default async (req) => {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) {
    return Response.json({ error: "AIRTABLE_TOKEN is not configured" }, { status: 500 });
  }
  const params = FIELDS.map((f) => "fields%5B%5D=" + encodeURIComponent(f)).join("&");
  const base = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}?pageSize=100&${params}`;
  const records = [];
  let offset;
  try {
    do {
      const res = await fetch(base + (offset ? `&offset=${encodeURIComponent(offset)}` : ""), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        return Response.json({ error: `Airtable responded ${res.status}` }, { status: 502 });
      }
      const j = await res.json();
      records.push(...(j.records || []));
      offset = j.offset;
    } while (offset);
  } catch (e) {
    return Response.json({ error: `Airtable fetch failed: ${e.message}` }, { status: 502 });
  }
  return Response.json(
    { generated: new Date().toISOString(), count: records.length, records },
    {
      headers: {
        // Browsers revalidate; Netlify's CDN holds it for 5 minutes.
        "Cache-Control": "public, max-age=0, must-revalidate",
        "Netlify-CDN-Cache-Control": "public, s-maxage=300",
        "X-Robots-Tag": "noindex, nofollow"
      }
    }
  );
};
