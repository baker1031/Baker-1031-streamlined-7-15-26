# Baker 1031 Investments — Website

Static site, no build step required. Open `index.html` or deploy the folder as-is (Netlify recommended — the request-access form uses Netlify Forms).

## Pages

| File | Page |
|---|---|
| `index.html` | Homepage (public) — hero video, strategies, chart, full-cycle DSTs, request-access popup form with Cal.com routing |
| `current-offerings.html` | Current Offerings listing (post-login) |
| `offering-template.html` | Offering detail page (post-login) — populated with AEI Healthcare Portfolio VII DST; every dynamic value tagged `data-field="<column name>"` for wiring to the offerings sheet |

## Shared pieces

- `css/tokens.css` — design tokens (colors, type, layout). Linked by every page **before** page-specific styles. Change brand values here only.
- `partials/nav-public.html` — public header (utility bar + logo/anchor nav + hamburger). Reference source of truth; pages inline a copy.
- `partials/nav-portal.html` — logged-in header ("Welcome, [First Name]" + Log Out).
- `partials/footer.html` — shared white footer (contact, explore, disclosure block).

Since there is no build step yet, the partials are *reference* files: edit the partial first, then sync the copies embedded in each page. If/when the site moves to Astro (see below), they become real imported components and the duplication disappears.

## Framework note

The site is fully static and already loads with zero framework runtime, which is as fast as serving gets. If a build step is added, **Astro** is the natural fit: it ships zero JS by default (same performance as these files), turns the partials into real shared components, and can generate `offering-*` pages directly from the offerings spreadsheet via content collections. Next.js only earns its weight if/when the investor portal needs real auth and server logic.

## Before launch (see project doc for the full gate)

- FINRA 2210 review; substantiate every `[bracketed]` figure
- Remove the form's "Skip (design mode)" button
- Privacy policy live (the form collects accreditation answers)
- Compress hero video (Cloudinary `q_auto,vc_auto,w_1920`), consider self-hosting the 84 sponsor logos (public logo.dev token)

## Kinde auth setup

- `js/auth.js` — Kinde PKCE client (CDN, no build). Login always routes to `current-offerings.html`; portal pages redirect unauthenticated visitors to Kinde; Log Out signs out. Self-sign-up is disabled by policy — accounts are provisioned by `netlify/functions/provision-user.mjs` after the request-access form is completed and a Cal.com meeting is booked (`bookingSuccessful` event).
- Netlify env vars required: `KINDE_DOMAIN`, `KINDE_M2M_CLIENT_ID`, `KINDE_M2M_CLIENT_SECRET` (from a Kinde Machine-to-Machine app with Management API `create:users` scope).
- Kinde dashboard: allowed callback + logout URLs must include the Netlify URL and production domain. Disable self-sign-up under the environment's policies.
