"use server";

import React from "react";
import { getKindeWidget, getLogoUrl } from "@kinde/infrastructure";

const SITE_URL = "https://baker1031.com";

const font =
  "-apple-system, system-ui, BlinkMacSystemFont, Helvetica, Arial, 'Segoe UI', Roboto, sans-serif";

const styles: Record<string, React.CSSProperties> = {
  loginForm: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    fontFamily: font,
  },
  logoLink: { display: "flex", justifyContent: "center", marginBottom: "1.5rem" },
  logo: { width: "12.5rem", height: "auto", display: "block" },
  welcome: {
    fontFamily: font,
    textAlign: "center",
    color: "#4a4a4a",
    fontSize: "0.95rem",
    margin: "0 0 0.2rem",
  },
  heading: {
    fontFamily: font,
    textAlign: "center",
    color: "#2f3237",
    fontWeight: 700,
    fontSize: "1.45rem",
    lineHeight: 1.3,
    letterSpacing: "-0.01em",
    margin: "0 0 1.4rem",
  },
  buttonRow: {
    display: "flex",
    gap: "0.75rem",
    marginTop: "1.4rem",
  },
  outlineBtn: {
    flex: 1,
    display: "block",
    textAlign: "center",
    padding: "0.72rem 0.5rem",
    border: "1px solid #2b3a5f",
    borderRadius: "6px",
    color: "#2b3a5f",
    fontFamily: font,
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    textDecoration: "none",
    background: "#ffffff",
  },
  helpLine: {
    fontFamily: font,
    textAlign: "center",
    fontSize: "0.88rem",
    color: "#4a4a4a",
    marginTop: "1.35rem",
    marginBottom: 0,
    lineHeight: 1.5,
  },
  helpLink: { color: "#2b3a5f", fontWeight: 600, textDecoration: "underline" },
  note: {
    fontFamily: font,
    fontSize: "0.8rem",
    color: "#8a8f99",
    lineHeight: 1.5,
    marginTop: "1.1rem",
    marginBottom: 0,
    textAlign: "center",
  },
};

export const Widget = (props: { heading: string; description: string }) => {
  return (
    <main style={styles.loginForm}>
      <a href={SITE_URL} style={styles.logoLink} aria-label="Baker 1031 Investments">
        <img src={getLogoUrl()} alt="Baker 1031 Investments" style={styles.logo} />
      </a>
      <p style={styles.welcome}>Welcome to the</p>
      <h2 style={styles.heading}>Baker 1031 Investor Portal</h2>
      {getKindeWidget()}
      <div style={styles.buttonRow}>
        <a href={`${SITE_URL}/?request-access=1`} style={styles.outlineBtn}>
          Request Access
        </a>
        <a href={SITE_URL} style={styles.outlineBtn}>
          Back to Site
        </a>
      </div>
      <p style={styles.helpLine}>
        Please contact{" "}
        <a href="mailto:invest@baker1031.com" style={styles.helpLink}>
          invest@baker1031.com
        </a>{" "}
        if you need help.
      </p>
      <p style={styles.note}>
        We&rsquo;ll email you a one-time sign-in code &mdash; no password needed.
        Access is provisioned after your request is reviewed.
      </p>
    </main>
  );
};
