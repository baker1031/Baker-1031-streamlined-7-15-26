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
    if (!authed) {
      if (!gateEl) {
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
      // Offering pages: the overlay handles the rest
      return;
    }
    sessionStorage.removeItem("b1031-auth-redirect");

    // Signed in: reveal the full nav and remember the name for instant
    // rendering on the next page load
    const displayName = user.given_name || user.email || "Investor";
    sessionStorage.setItem("b1031-name", displayName);
    applyAuthedNav(displayName);
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
