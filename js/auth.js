/* ============================================================
   Baker 1031 — Kinde authentication (PKCE, no build step)
   Loaded as <script type="module" src="js/auth.js"> on every page.

   Page detection:
   - Public page  (homepage): has #investor-login in the utility bar
   - Portal pages (offerings): have .account-box (Welcome + Log Out)

   Kinde dashboard requirements (Settings → Applications → this app):
   - Allowed callback URLs:  https://<your-domain>/  (and the Netlify URL)
   - Allowed logout URLs:    https://<your-domain>/
   ============================================================ */

import createKindeClient from "https://esm.sh/@kinde-oss/kinde-auth-pkce-js@4";

// Local file previews can't do OAuth redirects — skip auth entirely there
const isLocalPreview = window.location.protocol === "file:";

async function init() {
  if (isLocalPreview) return;

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

  /* ---------- Public page: Investor Login ---------- */
  const loginLink = document.getElementById("investor-login");
  if (loginLink) {
    if (authed) {
      loginLink.textContent = "Investor Portal";
      loginLink.href = "/current-offerings.html";
    } else {
      loginLink.addEventListener("click", function (e) {
        e.preventDefault();
        kinde.login({ app_state: { returnTo: "/current-offerings.html" } });
      });
    }
  }

  /* ---------- Generic hook: any #login button ---------- */
  // No register hook on purpose: self-sign-up is disabled. Accounts are
  // provisioned server-side after the request-access form + scheduled call.
  const genericLogin = document.getElementById("login");
  if (genericLogin) {
    genericLogin.addEventListener("click", async function (e) {
      e.preventDefault();
      await kinde.login();
    });
  }

  /* ---------- Offering pages: soft gate overlay ---------- */
  // Content stays in the HTML for crawlers; humans without a session get
  // a login overlay. Logged-in investors never see it.
  const gate = document.getElementById("offering-gate");
  if (gate) {
    if (authed) {
      gate.remove();
    } else {
      gate.style.display = "flex";
      document.documentElement.style.overflow = "hidden";
      const gateLogin = document.getElementById("offering-gate-login");
      if (gateLogin) {
        gateLogin.addEventListener("click", function (e) {
          e.preventDefault();
          kinde.login({ app_state: { returnTo: window.location.pathname } });
        });
      }
    }
  }

  /* ---------- Portal pages: guard + welcome + logout ---------- */
  const accountBox = document.querySelector(".account-box");
  if (accountBox) {
    if (!authed) {
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
      return;
    }
    sessionStorage.removeItem("b1031-auth-redirect");
    const nameEl = accountBox.querySelector('[data-field="First Name"]');
    if (nameEl) nameEl.textContent = user.given_name || user.email || "Investor";
    const logoutBtn = accountBox.querySelector(".logout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", function (e) {
        e.preventDefault();
        kinde.logout();
      });
    }
  }
}

init();
