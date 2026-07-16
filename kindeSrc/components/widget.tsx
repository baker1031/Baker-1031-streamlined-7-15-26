"use server";

import React from "react";
import { getKindeWidget } from "@kinde/infrastructure";

const SITE_URL = "https://streamlined-baker-1031.netlify.app"; // swap for baker1031.com at launch

const styles: Record<string, React.CSSProperties> = {
  loginForm: {
    minWidth: "400px",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
  },
  heading: { fontWeight: 600, fontSize: "1.8rem", color: "#2f3237" },
  description: { marginBottom: "1.5rem", color: "#4a4a4a", lineHeight: 1.55 },
  requestRow: {
    marginTop: "1.75rem",
    paddingTop: "1.25rem",
    borderTop: "1px solid #e4e4e4",
    fontSize: "0.92rem",
    color: "#4a4a4a",
  },
  requestLink: { color: "#2b3a5f", fontWeight: 600, textDecoration: "underline" },
};

export const Widget = (props: { heading: string; description: string }) => {
  return (
    <main style={styles.loginForm}>
      <div style={{ padding: "2rem" }}>
        <h2 style={styles.heading}>{props.heading}</h2>
        <p style={styles.description}>{props.description}</p>
        {getKindeWidget()}
        <p style={styles.requestRow}>
          Don&rsquo;t have an account yet?{" "}
          <a href={`${SITE_URL}/?request-access=1`} style={styles.requestLink}>
            Request Investment Access
          </a>
        </p>
      </div>
    </main>
  );
};
