/* ============================================================
   Airtable data layer (2026-07-31) — replaces the Google Sheet.

   Source of truth: Airtable base "Baker 1031 — Investments"
   (appjKrPkYahBOgE5Q). Tables consumed:
     - Identity & Offering  (one row per listing; typed fields, formulas,
       benchmark rollups, sponsor lookups)
     - Documents            (one row per offering document)
     - Sponsor Connection   (sponsor directory + rollup stats)
     - Sponsor Trackrecord  (deal-by-deal full-cycle results)

   Auth: set AIRTABLE_TOKEN in the environment (Netlify env var) — a
   personal access token with data.records:read on this base.

   Offline/dev fallback: set AIRTABLE_SNAPSHOT=<dir> containing
   identity-offering.json / documents.json / sponsor-connection.json /
   sponsor-trackrecord.json in REST response shape ({records:[{id,fields}]}).

   Everything returned from here is normalized into the SAME string
   shapes the sheet used to produce ("$50,000", "5.54%", "1.79x"), so
   the page builders downstream stay format-stable.
   ============================================================ */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BASE_ID = "appjKrPkYahBOgE5Q";
const TABLE_FILES = {
  "Identity & Offering": "identity-offering.json",
  "Documents": "documents.json",
  "Sponsor Connection": "sponsor-connection.json",
  "Sponsor Trackrecord": "sponsor-trackrecord.json",
};

async function fetchTable(table) {
  const snap = process.env.AIRTABLE_SNAPSHOT;
  if (snap) {
    const file = join(snap, TABLE_FILES[table]);
    console.log(`Airtable (snapshot): ${table} ← ${file}`);
    return JSON.parse(readFileSync(file, "utf8")).records;
  }
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) throw new Error("AIRTABLE_TOKEN is not set (and no AIRTABLE_SNAPSHOT dir given). Add it in Netlify → Site settings → Environment variables.");
  const records = [];
  let offset = "";
  do {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Airtable fetch failed for "${table}": ${res.status} ${await res.text().then((t) => t.slice(0, 200)).catch(() => "")}`);
    const page = await res.json();
    records.push(...page.records);
    offset = page.offset || "";
  } while (offset);
  console.log(`Airtable: ${table} → ${records.length} records`);
  return records;
}

/* ---------------- value formatters (Airtable typed → sheet strings) ---------------- */
const first = (v) => Array.isArray(v) ? v[0] : v; // lookups arrive as arrays
const str = (v) => v == null ? "" : String(first(v) ?? "").trim();
const num = (v) => {
  const x = first(v);
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};
/* $60,051,084 */
export const money = (v) => { const n = num(v); return n === null ? "" : "$" + Math.round(n).toLocaleString("en-US"); };
/* $19B / $958M / $3.35B — for AUM-style figures */
export const moneyCompact = (v) => {
  const n = num(v);
  if (n === null) return "";
  const f = (x) => (Math.round(x * 100) / 100).toString().replace(/\.0+$/, "").replace(/(\.\d)0$/, "$1");
  if (n >= 1e12) return `$${f(n / 1e12)}T`;
  if (n >= 1e9) return `$${f(n / 1e9)}B`;
  if (n >= 1e6) return `$${f(n / 1e6)}M`;
  return money(n);
};
/* 0.0554 → "5.54%" (fixed 2 decimals, matching the old sheet strings) */
export const pct2 = (v) => { const n = num(v); return n === null ? "" : (n * 100).toFixed(2) + "%"; };
/* 0.09 → "9%" ; 0.5085 → "50.9%" — short form for availability copy */
export const pctShort = (v) => {
  const n = num(v);
  if (n === null) return "";
  const p = n * 100;
  return (Math.abs(p - Math.round(p)) < 0.05 ? Math.round(p).toString() : p.toFixed(1)) + "%";
};
export const mult = (v) => { const n = num(v); return n === null ? "" : n.toFixed(2) + "x"; };
export const years = (v, label = " Years") => { const n = num(v); return n === null ? "" : (Math.round(n * 100) / 100).toString() + label; };
const plain = (v) => { const n = num(v); return n === null ? "" : (Math.round(n * 100) / 100).toString(); };

/* ---------------- status model ---------------- */
/* Raw Airtable statuses → what the public site shows.
   "Update Needed" is an internal workflow flag; per Jerry (2026-07-31) it
   displays publicly as "Confirm Availability" and ranks directly after
   Available. "Rejected" listings come off the directory entirely and get
   their own tab on the Performance page (like Closed). */
const STATUS_MAP = {
  "Available": "Available",
  "Update Needed": "Confirm Availability",
  "Limited Availability": "Limited Availability",
  "Accepting Backup Reservations": "Accepting Backup Reservations",
  "Coming Soon / Under Review": "Coming Soon / Under Review",
  "Coming Soon/Under Review": "Coming Soon / Under Review",
  "Under Review": "Coming Soon / Under Review",
  "Closed": "Closed",
  "Rejected": "Rejected",
};
export const STATUS_ORDER = ["Available", "Confirm Availability", "Limited Availability", "Accepting Backup Reservations", "Coming Soon / Under Review", "Closed", "Rejected"];
export const statusRank = (publicStatus) => {
  const i = STATUS_ORDER.indexOf(publicStatus);
  return i === -1 ? 4.5 : i;
};
export const statusClass = (publicStatus) => ({
  "Available": "",
  "Confirm Availability": "confirm",
  "Limited Availability": "limited",
  "Accepting Backup Reservations": "backup",
  "Coming Soon / Under Review": "soon",
  "Closed": "closed",
  "Rejected": "rejected",
}[publicStatus] ?? "soon");

const slugifyLocal = (s) => String(s || "").toLowerCase().trim().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/* ---------------- main entry ---------------- */
export async function loadAirtableData() {
  const [listRecs, docRecs, scRecs, trRecs] = await Promise.all([
    fetchTable("Identity & Offering"),
    fetchTable("Documents"),
    fetchTable("Sponsor Connection"),
    fetchTable("Sponsor Trackrecord"),
  ]);

  /* ----- guards: a broken base must fail the build, not blank the site ----- */
  if (listRecs.length < 10) throw new Error(`Only ${listRecs.length} listings from Airtable — refusing to build.`);
  if (docRecs.length < 50) throw new Error(`Only ${docRecs.length} document rows — refusing to build.`);
  if (scRecs.length < 20) throw new Error(`Only ${scRecs.length} sponsors — refusing to build.`);
  if (trRecs.length < 50) throw new Error(`Only ${trRecs.length} track-record rows — refusing to build.`);

  /* ----- sponsors (Sponsor Connection) ----- */
  const sponsorsById = new Map();
  const sponsors = scRecs
    .filter((r) => str(r.fields["Sponsor"]))
    .map((r) => {
      const f = r.fields;
      const website = str(f["Website"]);
      const s = {
        id: r.id,
        name: str(f["Sponsor"]),
        // Airtable's URL column carries Title-Case slugs (Go-Store-It-Partners);
        // lowercase them so existing /sponsors/<slug>/ URLs keep resolving.
        slug: slugifyLocal(str(f["URL"]) || str(f["Sponsor"])),
        preferred: /^yes$/i.test(str(f["Preferred?"])),
        founded: plain(f["Year Founded"]),
        aum: moneyCompact(f["AUM"]),
        description: str(f["Description / Overview"]),
        advantages: [1, 2, 3, 4, 5].map((i) => str(f[`Key Strategy / Advantage ${i}`])).filter(Boolean),
        website,
        domain: website.replace(/^https?:\/\//i, "").replace(/\/.*$/, ""),
        hq: str(f["Headquarters"]),
        logo: str(f["Logo URL"]),
        fullCycle: plain(f["Full-Cycle Deals"]),
        avgAnnual: pct2(f["Average Annual Return"]),
        avgMultiple: mult(f["Average Equity Multiple"]),
        avgHold: years(f["Average Hold Period (yrs)"]),
        trackIds: Array.isArray(f["Sponsor Trackrecord"]) ? f["Sponsor Trackrecord"] : [],
        deals: [], // filled below
        success: "", // computed below from deal-level equity multiples
      };
      sponsorsById.set(r.id, s);
      return s;
    });

  /* ----- deal-by-deal track record ----- */
  const deals = trRecs
    .filter((r) => str(r.fields["Sponsor"]) && str(r.fields["Investment"]))
    .map((r) => {
      const f = r.fields;
      return {
        id: r.id,
        sponsor: str(f["Sponsor"]),
        investment: str(f["Investment"]),
        location: str(f["Location"]),
        assetClass: str(f["Asset Class"]),
        hold: plain(f["Hold Period (yrs)"]),
        multiple: mult(f["Equity Multiple"]),
        annual: pct2(f["Annual Return"]),
        _holdN: num(f["Hold Period (yrs)"]),
        _multN: num(f["Equity Multiple"]),
        _annN: num(f["Annual Return"]),
        sponsorId: (Array.isArray(f["Sponsor Connection"]) ? f["Sponsor Connection"][0] : null),
      };
    });
  const dealsById = new Map(deals.map((d) => [d.id, d]));
  for (const s of sponsors) {
    s.deals = s.trackIds.map((id) => dealsById.get(id)).filter(Boolean);
    // Fallback for deals not linked yet: match by sponsor name
    if (!s.deals.length) s.deals = deals.filter((d) => d.sponsor.toLowerCase() === s.name.toLowerCase());
    /* Full-cycle success = share of this sponsor's completed programs (with a
       reported equity multiple) that returned at least 1.00x investor equity.
       Computed from the deal-level dataset — the old sheet's sponsor-reported
       "Success Rate" column has no Airtable equivalent. */
    const ms = s.deals.map((d) => d._multN).filter((x) => x !== null);
    if (ms.length) s.success = ((ms.filter((x) => x >= 1).length / ms.length) * 100).toFixed(1).replace(/\.0$/, "") + "%";
  }

  /* ----- documents ----- */
  const docs = docRecs
    .map((r) => ({
      name: str(r.fields["Investment Name"]),
      label: str(r.fields["Label"]),
      file: str(r.fields["File"]),
      gated: str(r.fields["Gated?"]),
    }))
    .filter((d) => d.name && d.label && d.file);

  /* ----- offerings (Identity & Offering) ----- */
  const offerings = listRecs
    .filter((r) => str(r.fields["Investment Name"]))
    .map((r) => {
      const f = r.fields;
      const rawStatus = str(f["Status"]);
      const publicStatus = STATUS_MAP[rawStatus] || rawStatus || "Coming Soon / Under Review";
      const sponsorRec = sponsorsById.get(Array.isArray(f["Sponsor Connection"]) ? f["Sponsor Connection"][0] : "");
      const equityN = num(f["Equity"]);
      const availN = num(f["Available Equity"]);
      const availPct = publicStatus === "Closed" ? "0%"
        : (equityN && availN != null ? pctShort(availN / equityN) : str(f["Available %"]));
      const ltvN = num(f["In-Place LTV"]);
      const debtN = num(f["Debt"]);
      const yieldN = num(f["Average Yield"]);
      const minN = num(f["Minimum Investment"]);

      const o = {
        /* ---- legacy sheet-shaped fields (page builders depend on these names) ---- */
        "Investment Name": str(f["Investment Name"]),
        "Sponsor": str(f["Sponsor"]),
        "Structure": str(f["Structure"]),
        "Status": publicStatus,
        "Total Offering": money(f["Total Offering"]),
        "Equity": money(f["Equity"]),
        "Debt": debtN === null ? "" : (debtN === 0 ? "$0" : money(debtN)),
        "In-Place LTV": ltvN === null ? "" : pct2(ltvN) + " LTV",
        "Available Equity": availN === null ? "" : money(availN),
        "Available Percentage": availPct,
        "Last Updated": str(f["Last Updated"]),
        "Property Type": str(f["Property Type"]),
        "Location (Use)": str(f["Location (Use)"]) || str(f["Location"]),
        "Total Load": str(f["Total Load"]),
        "Strategy": str(f["Strategy"]),
        "721 Exchange Exit": str(f["721 Exchange Exit"]),
        "Estimated Hold Period": str(f["Estimated Hold Period"]),
        "Description": str(f["Description"]),
        "Highlight 1": str(f["Highlight 1"]), "Highlight 2": str(f["Highlight 2"]),
        "Highlight 3": str(f["Highlight 3"]), "Highlight 4": str(f["Highlight 4"]),
        "Highlight 5": str(f["Highlight 5"]),
        "Pros": str(f["Pros"]), "Cons": str(f["Cons"]), "Insights": str(f["Insights"]),
        "Y1": pct2(f["Y1"]), "Y2": pct2(f["Y2"]), "Y3": pct2(f["Y3"]), "Y4": pct2(f["Y4"]), "Y5": pct2(f["Y5"]),
        "Y6": pct2(f["Y6"]), "Y7": pct2(f["Y7"]), "Y8": pct2(f["Y8"]), "Y9": pct2(f["Y9"]), "Y10": pct2(f["Y10"]),
        "Average Yield": pct2(f["Average Yield"]),
        "Cap Rate Equivalent": pct2(f["Cap Rate Equivalent"]),
        /* The Airtable "Tax Adjusted Yield (Use)" formula divides twice; the
           source-of-truth display string lives in "Tax-Adj. Yield". */
        "Tax Adjusted Yield (Use)": str(f["Tax-Adj. Yield"]),
        "Tax Adj Label": str(f["Tax Adj Label"]) || "Tax-Adjusted Yield",
        "Lender": str(f["Lender"]),
        "Interest Rate": str(f["Interest Rate"]),
        "Loan Term": str(f["Loan Term"]),
        "I/O Period": str(f["I/O Period"]),
        "Amortization": str(f["Amortization"]),
        "Y1 DSCR": str(f["Y1 DSCR"]),
        "Property Photo Link": str(f["Property Photo Link"]),
        "Photo Link Use": str(f["Photo Link Use"]) || str(f["Property Photo Link"]),
        "Minimum Investment": money(f["Minimum Investment"]),
        "URL": str(f["URL"]),
        /* ---- benchmarks (deal vs market rollups computed in Airtable) ---- */
        "BM: Avg. Income - Deal": pct2(f["Average Yield"]),
        "BM: Avg. Income - MKT": pct2(f["Avg. Income - MKT"]),
        "BM: Avg. Income - Interpret": str(f["Avg. Income - Interpret"]),
        "BM: Growth - Deal": pct2(f["Growth - Deal"]),
        "BM: Growth- MKT": pct2(f["Growth - MKT"]),
        "BM: Growth - Interpret": str(f["Growth - Interpret"]),
        "BM: Peak - Deal": pct2(f["Peak - Deal"]),
        "BM: Peak- MKT": pct2(f["Peak - MKT"]),
        "BM: Peak - Interpret": str(f["Peak - Interpret"]),
        /* ---- sponsor block (lookups + linked Sponsor Connection row) ---- */
        "Investment Firm": sponsorRec?.name || str(f["Sponsor"]),
        "Sponsor Founded": plain(f["Sponsor Year Founded"]) || sponsorRec?.founded || "",
        "Headquarters (City, State)": str(f["Sponsor HQ"]) || sponsorRec?.hq || "",
        "Website": str(f["Sponsor Website"]) || sponsorRec?.website || "",
        "Sponsor Description": sponsorRec?.description || "",
        "Sponsor Image": str(f["Sponsor Logo URL"]) || sponsorRec?.logo || "",
        "Full-Cycle Count": plain(f["Sponsor Full-Cycle Deals"]) || sponsorRec?.fullCycle || "",
        "Sponsor AAR": pct2(f["Sponsor Avg Annual Return"]) || sponsorRec?.avgAnnual || "",
        "Sponsor AEM": mult(f["Sponsor Avg Equity Multiple"]) || sponsorRec?.avgMultiple || "",
        "Sponsor Hold": years(f["Sponsor Avg Hold Period (yrs)"]) || sponsorRec?.avgHold || "",
        "Sponsor Success": sponsorRec?.success || "",
        /* ---- new Airtable-era fields ---- */
        "Offering Type (Reg D)": str(f["Offering Type (Reg D)"]),
        "Loan Type": str(f["Loan Type"]),
        "Connected REIT": str(f["Connected REIT"]),
        "MSA Tier": num(f["MSA Tier"]) === null ? "" : `Tier ${num(f["MSA Tier"])}`,
        "Y1 Payout Ratio": plain(f["Y1 Payout Ratio"]),
        "Initial Reserves": pct2(f["Initial Reserves % of Offering"]),
        /* ---- internals ---- */
        _id: r.id,
        _created: r.createdTime || "",
        _statusRaw: rawStatus,
        _statusClass: statusClass(publicStatus),
        _rank: statusRank(publicStatus),
        _sponsorRec: sponsorRec || null,
        _advantages: sponsorRec?.advantages || [],
        _minN: minN, _yieldN: yieldN, _ltvN: ltvN, _debtN: debtN,
        _availN: equityN && availN != null ? (availN / equityN) * 100 : null,
        _qc: str(f["QC Check"]),
      };
      o._slug = slugifyLocal(o["URL"] || o["Investment Name"]);
      return o;
    });

  return { offerings, docs, sponsors, deals };
}
