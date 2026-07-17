/* ============================================================
   Baker 1031 — Kinde authentication (PKCE, no build step)
   Loaded as <script type="module" src="js/auth.js"> on every page.

   Page detection:
   - Public page  (homepage): has #investor-login in the utility bar
   - Offering pages: have #offering-gate (soft gate) + .account-box
     with hidden Welcome/Log Out that auth.js reveals when signed in
   - Portal pages (offerings directory): have .account-box and NO
     #offering-gate → hard gate (redirect to login)

   Buttons are wired IMMEDIATELY on page load; clicks await the auth
   client (which loads from a CDN and can take a few seconds), so a
   fast click after navigation still works.

   Kinde dashboard requirements (Settings → Applications → this app):
   - Allowed callback URLs:  https://<your-domain>/  (and the Netlify URL)
   - Allowed logout URLs:    https://<your-domain>/
   ============================================================ */

/* ---------- Google Analytics 4 (loaded on every page via this shared module) ---------- */
(function loadGA() {
  var id = "G-P29LR49RL8";
  if (window.gtag) return;
  var s = document.createElement("script");
  s.async = true;
  s.src = "https://www.googletagmanager.com/gtag/js?id=" + id;
  document.head.appendChild(s);
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  window.gtag("js", new Date());
  window.gtag("config", id);
})();

/* ---------- Light content-protection deterrents ----------
   Best-effort deterrents only. These run in the browser AFTER load, so they do
   NOT affect performance meaningfully, do NOT touch crawlers/LLMs (bots don't
   execute JS), and leave text selection/keyboard accessibility intact.
   NOTE: a browser fundamentally cannot block OS screenshots, screen recording,
   or screen-sharing, and dev-tools "blocking" is unreliable + hurts perf, so
   those are intentionally omitted (per the no-performance-impact requirement). */
(function contentProtection() {
  try {
    // Disable right-click context menu and image drag-to-save
    document.addEventListener("contextmenu", function (e) { e.preventDefault(); }, { capture: true });
    document.addEventListener("dragstart", function (e) { if (e.target && e.target.tagName === "IMG") e.preventDefault(); });
    // Best-effort intercept of save/print/devtools shortcuts (OS-level capture cannot be blocked)
    document.addEventListener("keydown", function (e) {
      var k = (e.key || "").toLowerCase();
      var mod = e.ctrlKey || e.metaKey;
      if (mod && (k === "s" || k === "p")) { e.preventDefault(); return false; }
      if (mod && e.shiftKey && (k === "i" || k === "j" || k === "c")) { e.preventDefault(); return false; }
      if (k === "printscreen") { try { navigator.clipboard && navigator.clipboard.writeText(""); } catch (_) {} }
    });
  } catch (_) {}
})();

// Local file previews can't do OAuth redirects — skip auth entirely there
const isLocalPreview = window.location.protocol === "file:";

/* ---------- Auth client boots in the background ---------- */
const ready = (async function () {
  if (isLocalPreview) return null;

  const { default: createKindeClient } =
    await import("https://esm.sh/@kinde-oss/kinde-auth-pkce-js@4");

  const kinde = await createKindeClient({
    client_id: "2405a754fefd43828d42f3c83e806a36",
    domain: "https://auth.baker1031.com",
    redirect_uri: window.location.origin,
    // Persist the session across full page loads (static site = every
    // navigation is a new page). Without this, portal pages always see
    // "logged out" and bounce through Kinde in an endless loop.
    is_dangerously_use_local_storage: true,
    on_redirect_callback: (user, appState) => {
      // Deep links win: if login started from a protected page, return there.
      // Otherwise every successful login lands on the listings directory.
      if (appState && appState.returnTo) {
        window.location.replace(appState.returnTo);
      } else if (user) {
        window.location.replace("/current-offerings.html");
      }
    }
  });

  let user = null;
  try { user = kinde.getUser(); } catch (e) { user = null; }
  let authed = !!(user && (user.id || user.email));
  // Fresh page load: tokens may need a silent refresh before getUser works
  if (!authed) {
    try {
      await kinde.getToken();
      user = kinde.getUser();
      authed = !!(user && (user.id || user.email));
    } catch (e) { /* stay logged out */ }
  }

  // One-click portal entry after provisioning (email prefilled on the login screen)
  window.baker1031Login = function (email) {
    kinde.login({
      app_state: { returnTo: "/current-offerings.html" },
      login_hint: email,
      authUrlParams: { login_hint: email }
    });
  };

  return { kinde, user, authed };
})();

/* ---------- Instant nav state from the last known session ----------
   Kills the nav flicker between page loads: we render the signed-in nav
   immediately from a cached name, then reconcile once auth resolves. */
function applyAuthedNav(name) {
  const box = document.querySelector(".account-box");
  if (!box) return;
  box.querySelectorAll(".portal-link, .nav-sep").forEach(function (el) { el.style.display = ""; });
  const nameEl = box.querySelector('[data-field="First Name"]');
  if (nameEl && name) nameEl.textContent = name;
  const welcomeEl = box.querySelector(".welcome");
  if (welcomeEl) welcomeEl.style.display = "";
  const boxLogin = box.querySelector("#investor-login");
  if (boxLogin) boxLogin.style.display = "none";
  const logoutBtn = box.querySelector(".logout:not(#investor-login)");
  if (logoutBtn) logoutBtn.style.display = "";
  // Homepage only: swap the marketing nav for the portal nav
  if (box.id === "home-account") {
    box.classList.add("authed");
    document.body.classList.add("portal-nav"); // shrinks the homepage logo/header to match portal pages
    const pnav = document.querySelector(".primary-nav");
    if (pnav) pnav.style.display = "none";
    const ubar = document.querySelector(".utility-bar");
    if (ubar) ubar.style.display = "none";
  }
}
function applyLoggedOutNav() {
  const box = document.querySelector(".account-box");
  if (!box) return;
  box.querySelectorAll(".portal-link, .nav-sep, .welcome, .logout:not(#investor-login)").forEach(function (el) { el.style.display = "none"; });
  const boxLogin = box.querySelector("#investor-login");
  if (boxLogin) boxLogin.style.display = "";
  // Homepage only: restore the marketing nav
  if (box.id === "home-account") {
    box.classList.remove("authed", "open");
    document.body.classList.remove("portal-nav");
    const pnav = document.querySelector(".primary-nav");
    if (pnav) pnav.style.display = "";
    const ubar = document.querySelector(".utility-bar");
    if (ubar) ubar.style.display = "";
  }
}
const cachedName = sessionStorage.getItem("b1031-name");
if (cachedName) applyAuthedNav(cachedName);

/* ---------- Wire buttons NOW; act when the client is ready ---------- */

const loginLink = document.getElementById("investor-login");
if (loginLink) {
  loginLink.addEventListener("click", async function (e) {
    e.preventDefault();
    const s = await ready;
    if (!s) return;
    if (s.authed) {
      window.location.href = "/current-offerings.html";
    } else {
      s.kinde.login({ app_state: { returnTo: "/current-offerings.html" } });
    }
  });
}

const genericLogin = document.getElementById("login");
if (genericLogin) {
  // No register hook on purpose: self-sign-up is disabled. Accounts are
  // provisioned server-side after the request-access form + scheduled call.
  genericLogin.addEventListener("click", async function (e) {
    e.preventDefault();
    const s = await ready;
    if (s) await s.kinde.login();
  });
}

const gateEl = document.getElementById("offering-gate");
const gateLogin = document.getElementById("offering-gate-login");

/* ---------- Login gate (Learn + Performance + Listings) ----------
   Login-only for humans, but crawlable for search/LLM bots: the full content is
   rendered in the page HTML (bots don't run this JS, so they index everything),
   while signed-out humans get a NON-dismissible register/sign-in wall. Paired
   with `isAccessibleForFree:false` paywall markup in the JSON-LD so serving
   content to crawlers but gating users is not treated as cloaking. */
function showSoftGate(kinde) {
  if (document.getElementById("soft-gate")) return;
  const el = document.createElement("div");
  el.id = "soft-gate";
  el.innerHTML =
    '<div class="soft-gate-card" role="dialog" aria-modal="true" aria-label="Sign in or request access">' +
    '<div class="soft-gate-kicker">Baker 1031 &middot; Investor access</div>' +
    '<h2>Sign in to view this page</h2>' +
    '<p>This content is available to registered investors. Request free access &mdash; it takes about two minutes, and there&rsquo;s no cost or obligation. Access is provisioned after a brief introductory call.</p>' +
    '<button type="button" class="soft-gate-btn" id="soft-gate-register">Request free access &rarr;</button>' +
    '<button type="button" class="soft-gate-dismiss" id="soft-gate-login">Already have an account? Sign in</button>' +
    "</div>";
  document.body.appendChild(el);
  document.getElementById("soft-gate-register").addEventListener("click", function () {
    // Self-sign-up is disabled in Kinde (accounts are provisioned after the
    // access-request form + intro call), so do NOT call kinde.register() —
    // it dead-ends on "organization is not accepting registrations".
    // Route to the homepage access-request popup instead.
    window.location.href = "/?request-access=1";
  });
  document.getElementById("soft-gate-login").addEventListener("click", function () {
    kinde.login({ app_state: { returnTo: window.location.pathname + window.location.search } });
  });
  document.documentElement.style.overflow = "hidden"; // non-dismissible: lock scroll behind the wall
}
function removeSoftGate() {
  const el = document.getElementById("soft-gate");
  if (el) el.remove();
  document.documentElement.style.overflow = "";
}
if (gateLogin) {
  gateLogin.addEventListener("click", async function (e) {
    e.preventDefault();
    const s = await ready;
    if (s) s.kinde.login({ app_state: { returnTo: window.location.pathname } });
  });
}

/* ---------- Once auth state is known, update the page ---------- */
ready.then(function (s) {
  if (!s) return;
  const { kinde, user, authed } = s;

  // Public-page login link: flip to a portal link when signed in
  if (loginLink && authed) {
    loginLink.textContent = "Investor Portal";
    loginLink.href = "/current-offerings.html";
  }

  // Soft gate (offering pages): show overlay only to signed-out visitors
  if (gateEl) {
    if (authed) {
      gateEl.remove();
    } else {
      gateEl.style.display = "flex";
      document.documentElement.style.overflow = "hidden";
    }
  }

  // Account box (Welcome + Log Out)
  const accountBox = document.querySelector(".account-box");
  if (accountBox) {
    // Page gate classification (body[data-gate]): "soft" = Learn/Performance
    // (overlay prompt, content stays crawlable), "public" = supporting SEO
    // content (no gate), else hard gate (portal directory). The homepage's
    // #home-account is always public.
    const isHomeNav = accountBox.id === "home-account";
    const gateType = document.body.getAttribute("data-gate");
    const isPublic = isHomeNav || gateType === "public";
    const isSoft = gateType === "soft" || !!gateEl;
    if (!authed) {
      if (isSoft) {
        showSoftGate(kinde);
      } else if (!isPublic) {
        // Portal directory: hard gate — send to Kinde, then back here.
        // Loop breaker: if we already bounced through Kinde seconds ago and
        // still look logged out, stop redirecting instead of flickering.
        const last = Number(sessionStorage.getItem("b1031-auth-redirect") || 0);
        if (Date.now() - last < 30000) {
          sessionStorage.removeItem("b1031-auth-redirect");
          window.location.replace("/");
          return;
        }
        sessionStorage.setItem("b1031-auth-redirect", String(Date.now()));
        kinde.login({ app_state: { returnTo: window.location.pathname + window.location.search } });
      }
      // Stale cache (logged out elsewhere): revert to the signed-out nav
      sessionStorage.removeItem("b1031-name");
      applyLoggedOutNav();
      return;
    }
    removeSoftGate();
    sessionStorage.removeItem("b1031-auth-redirect");

    // Signed in: reveal the full nav and remember the name for instant
    // rendering on the next page load
    const displayName = user.given_name || user.email || "Investor";
    sessionStorage.setItem("b1031-name", displayName);
    applyAuthedNav(displayName);
    // Investor-only site search (Algolia): loaded ONLY after auth is
    // confirmed, so signed-out visitors never get a search UI at all.
    // SEARCHJS_V is stamped with search.js's content hash at build time —
    // /js/* is cached immutable, so the import URL must change with the file.
    import(new URL("./search.js?v=SEARCHJS_V", import.meta.url).href)
      .then(function (m) { m.initSearch(); })
      .catch(function () { /* search is optional — never break the page */ });
    const logoutBtn = accountBox.querySelector(".logout:not(#investor-login)");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function (e) {
        e.preventDefault();
        sessionStorage.removeItem("b1031-name");
        kinde.logout();
      });
    }
  }
});

/* ---------- Portal-nav "Home" dropdown: click/keyboard toggle (hover is CSS).
   Runs on every page that has the dropdown, so behaviour is identical
   across the homepage and all portal pages. ---------- */
(function () {
  const home = document.querySelector(".nav-home");
  if (!home) return;
  const toggle = home.querySelector(".nav-home-toggle");
  if (toggle) {
    toggle.addEventListener("click", function (e) {
      e.preventDefault();
      const open = home.classList.toggle("open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }
  document.addEventListener("click", function (e) {
    if (!home.contains(e.target)) home.classList.remove("open");
  });
})();
