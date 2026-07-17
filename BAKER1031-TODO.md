# Baker 1031 — Final To-Do List

_As of 2026-07-17. Repo: baker1031/Baker-1031-streamlined-7-15-26 → Netlify → baker1031.com_

Everything below is what's left. Items are grouped by who owns them and roughly ordered by priority. Anything not listed here is built and live.

---

## A. Do first — security

- [ ] **Rotate the 3 tokens that were pasted into chat** and update the Netlify env vars — treat all three as compromised:
  - GitHub PAT (the deploy is currently still using it — see note below)
  - Pipedrive API token
  - TickTick token
- [ ] **Refresh the build container's GitHub token.** The container's own `GH_TOKEN` has gone invalid, so the last several pushes fell back to the chat-pasted PAT. When you rotate the PAT, also update whatever token the automated/Netlify side uses, or the next non-manual push will fail.

## B. Compliance decisions (need your broker-dealer)

- [ ] **FINRA Rule 2210 review** of all public educational content: Learn (525 pages), glossary (50), markets (63), audiences (6), calculators (10), and now **sponsor profiles (86, incl. deal-by-deal track-record tables)**. Sponsor figures are sponsor-reported and labeled as such; "Preferred" is stated as Baker's internal designation on every page.
- [ ] **Reg D sign-off on indexing:** Performance, Listings, and Sponsors are login-gated for humans but crawlable/indexable (paywall markup, not hard-blocked). Confirm the BD is OK with that, or tell me to switch any of them back to `noindex`/hard-gate.
- [ ] **Supply the real compliance reviewer** name / title / CRD — pages show a generic "Aurora Securities compliance" line today.
- [ ] **Own the markets tax-data currency** — `data/markets.json` is as-of-2025 and drifts yearly.

## C. Granola → Pipedrive — CODE IS SHIPPED, needs your wiring

The receiver is live at `/.netlify/functions/granola-sync`. It logs the meeting summary as a **Note**, **creates the person if they're not already in Pipedrive**, logs a completed **meeting** activity, and turns the meeting's **action items into open task** activities (due in 3 days) — on the matching person + their open deal. De-dupes so a re-fired Zap won't double-post. It's inert until you do these three things:

- [ ] **Granola:** be on a paid/Business plan and enable the Zapier integration (Settings → Integrations → Zapier).
- [ ] **Zapier:** build one Zap — trigger "Note added to Granola folder" (or "Note shared to Zapier") → action "Webhooks by Zapier → POST" to
  `https://baker1031.com/.netlify/functions/granola-sync?secret=<GRANOLA_WEBHOOK_SECRET>`
  sending JSON with the meeting title, attendee emails, the enhanced summary, and (optional) the action-items field. The function reads the common field names automatically.
- [ ] **Netlify env vars:** set `GRANOLA_WEBHOOK_SECRET` (any long random string, must match the Zap URL) and `GRANOLA_OWNER_EMAIL` (your address, so you're skipped as an attendee). Optional: `GRANOLA_TASK_DUE_DAYS` (default 3), `GRANOLA_SKIP_UNKNOWN=1` (turn OFF auto-creating people), `GRANOLA_INCLUDE_TRANSCRIPT=1`.
- [ ] Send one test meeting through and confirm the note + tasks land on the right person.

## D. Sheet data fixes (the "what's missing" answer)

These are the concrete gaps I found in the live sheet. Fixing them in the sheet auto-rebuilds the site.

**Malformed equity multiples (6 deals — show "—" until fixed):** Bluerock — Domain at the One Forty; Capital Square — CS1031 Bedford Parke Apartments; Moody National — Moody DFW DST; NexPoint — NREA Estates DST; Passco — Haven at West Melbourne (all recorded as `2.x`); Time Equities — Viscoe Road TIC (`.x`).

**Blank annual returns (5 deals):** Blue Door — Southwest Colonial; Blue Door — USA Self Storage I; Moody National — Moody Village One DST; Time Equities — Renaissance Equities LLC; Time Equities — Viscoe Road TIC.

**Trackrecord blanks (cosmetic — cells show "—"):** 138 rows missing Location, 79 missing Asset Class, 9 missing Hold Period. Worth filling for the sponsors you care most about (they populate the deal tables).

**Sponsor Connection blanks:** *Secure Properties* is missing Website, Logo, and AUM (its page will be very thin). AUM also blank for ERP, NewStar Exchange, The Wyoming Reserve, IDEAL Capital Group. Year Founded blank for The Wyoming Reserve, Secure Properties.

**Missing Documents rows** (offering pages with no PPM/supplement):
- **IREX IV Industrial Portfolio DST** (Invesco) — *Available, zero documents*
- **HPA Exchange – Vital Medical Dallas TX DST** — *Available, zero documents*
- **BT Athens Student Housing DST** (Baker Tilly) — Coming Soon, zero documents
- Open listings with only a PPM and no property supplement: Blue Door II, Griffin Capital (Union – KC), Moody Med Center 2, NexPoint Oasis / Small Bay III / Waterford, Passco Preston Ridge, PG Manchester Industrial, Inland Mokena Senior Living.

**Orphaned track record:** "Blue Door" has 2 deals in Sponsor Trackrecord but no row in Sponsor Connection, so it gets no profile page and those deals appear nowhere. Add a Sponsor Connection row for Blue Door (or rename to match an existing firm) to surface them.

**Note on thin sponsor pages:** 62 of the 86 sponsors have no full-cycle deals in the Trackrecord tab, so their pages show the firm/overview/strategy but no track-record table (by design). That's expected, not a bug — but if you expected deals for any big names on that list (e.g. Inland is there via a different spelling? — it matched; but Blackstone, Ares, KKR, Hines, Nuveen, etc. have none), it usually means the Trackrecord sponsor name doesn't match the Connection name exactly.

## E. Content pages still to build

- [ ] **Property-type pages (16):** Data Center, Government-Leased, Healthcare, Hospitality, Industrial, Land, Life Sciences, Marina, Multifamily, Net Lease, Office, Oil & Gas Royalties, Self-Storage, Senior Living, Small-Bay Industrial, Student Housing. (Own section like Markets/Audiences; legacy copy exists.)
- [ ] **Legal / compliance HTML pages:** Terms, Reg BI / DST suitability, CCPA notice, Accessibility statement, Disclosures, Commitment to Privacy. (Privacy Policy + Form CRS already exist as linked PDFs; these others currently 404.)
- [ ] Optional: Process page, testimonials.

## F. Content quality (Learn migration)

- [ ] **Reconstruct flattened comparison tables as real HTML tables** — DST-vs-REIT / OZ-vs-1031 feature grids, yield-by-sector tables, and Jerry's bio deal table still render as run-on text (needs source HTML or manual data entry).

## G. Performance & accessibility (deferred — bigger/riskier)

- [ ] **Externalize duplicated inline CSS** — each generated page inlines ~9–14KB of identical layout CSS; move shared chunks to a fingerprinted `css/layout.css`.
- [ ] **Trim the ~66KB Learn sidebar** — the full 525-item tree repeats on every Learn page; render only the current pillar's children.
- [ ] **Image dimensions** (width/height) on logos/heroes to stop layout shift; route the offering hero LCP image through Cloudinary + `fetchpriority`.
- [ ] **preconnect** esm.sh + res.cloudinary.com (or vendor the Kinde SDK same-origin to drop the 3rd-party fetch).
- [ ] **Tab ARIA** on the Performance tabs; **prefers-reduced-motion** to pause the hero video.
- [ ] **Hub ItemList / CollectionPage JSON-LD** on the learn/glossary/markets/sponsors hubs (none today).

## H. Verify after deploys settle

- [ ] Signed-out → login wall on Learn / Performance / Listings / Sponsors (no bypass); signed-in → passes through; glossary/markets/audiences/calculators public.
- [ ] Legacy `/<slug>.html` and `/sponsor-*.html` URLs 301 to their new paths; `robots.txt`, `llms.txt`, `sitemap.xml` (830 URLs) serve.
- [ ] **GA4:** confirm G-P29LR49RL8 is the intended property and check Realtime for pageviews + the `generate_lead` / `schedule` events after a test submission/booking.

---

### Done in the latest round (for reference)
Sponsors behind the login gate; **86 sponsor profile pages** generated from the sheet with **deal-by-deal track-record tables for the 24 sponsors that have full-cycle deals**; sponsor hub (Preferred-first + A–Z) + sitemap/llms entries; Learn hub now links Sponsors, Markets & Who We Help (even 3×4 grid); Granola→Pipedrive receiver function shipped; soft-gate "Register free" CTA fixed.
