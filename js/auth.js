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
    domain: "https://baker1031investments.kinde.com",
    redirect_uri: window.location.origin,
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
  const authed = !!(user && (user.id || user.email));

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

  /* ---------- Portal pages: guard + welcome + logout ---------- */
  const accountBox = document.querySelector(".account-box");
  if (accountBox) {
    if (!authed) {
      // Not signed in: send to Kinde, then back to the page they wanted
      kinde.login({ app_state: { returnTo: window.location.pathname + window.location.search } });
      return;
    }
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
