"use server";

import React from "react";
import { getKindeWidget } from "@kinde/infrastructure";

const SITE_URL = "https://streamlined-baker-1031.netlify.app"; // swap for baker1031.com at launch

const serif = "Georgia, 'Times New Roman', Times, serif";

const styles: Record<string, React.CSSProperties> = {
  loginForm: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  welcome: {
    fontFamily: serif,
    textAlign: "center",
    color: "#2b3a5f",
    fontSize: "1.05rem",
    margin: "0 0 0.15rem",
  },
  heading: {
    fontFamily: serif,
    textAlign: "center",
    color: "#2b3a5f",
    fontWeight: 600,
    fontSize: "1.65rem",
    lineHeight: 1.25,
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
    color: "#2b3a5f",
    fontSize: "0.78rem",
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    textDecoration: "none",
    background: "#ffffff",
  },
  helpLine: {
    textAlign: "center",
    fontSize: "0.88rem",
    color: "#4a4a4a",
    marginTop: "1.35rem",
    marginBottom: 0,
    lineHeight: 1.5,
  },
  helpLink: { color: "#2b3a5f", fontWeight: 600, textDecoration: "underline" },
  note: {
    fontSize: "0.8rem",
    color: "#6b7280",
    lineHeight: 1.5,
    marginTop: "1.1rem",
    marginBottom: 0,
    textAlign: "center",
  },
};

export const Widget = (props: { heading: string; description: string }) => {
  return (
    <main style={styles.loginForm}>
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
