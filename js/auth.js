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
      // After login, return the user to where they were headed
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

  /* ---------- Generic hooks: any #login / #register button, per Kinde quickstart ---------- */
  const genericLogin = document.getElementById("login");
  if (genericLogin) {
    genericLogin.addEventListener("click", async function (e) {
      e.preventDefault();
      await kinde.login({ app_state: { returnTo: "/current-offerings.html" } });
    });
  }
  const genericRegister = document.getElementById("register");
  if (genericRegister) {
    genericRegister.addEventListener("click", async function (e) {
      e.preventDefault();
      await kinde.register({ app_state: { returnTo: "/current-offerings.html" } });
    });
  }

  /* ---------- Portal pages: guard + welcome + logout ---------- */
  const accountBox = document.querySelector(".account-box");
  if (accountBox) {
    if (!authed) {
      // Not signed in: send to Kinde, then back to this page
      kinde.login({ app_state: { returnTo: window.location.pathname } });
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
