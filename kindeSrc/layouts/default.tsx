import React from "react";

const SITE_URL = "https://streamlined-baker-1031.netlify.app"; // swap for baker1031.com at launch

const styles: Record<string, React.CSSProperties> = {
  container: { display: "flex", minHeight: "100vh", background: "#ffffff" },
  sidePanel: {
    background: "linear-gradient(135deg, #2b3a5f 0%, #1e2a47 100%)",
    flex: 1,
    margin: "0.5rem",
    borderRadius: "1rem",
    maxWidth: "1024px",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    padding: "3rem",
    color: "#ffffff",
  },
  brand: { fontSize: "1.4rem", fontWeight: 700, letterSpacing: "0.14em", marginBottom: "1.25rem" },
  tagline: { fontSize: "2rem", fontWeight: 700, lineHeight: 1.2, marginBottom: "1rem" },
  copy: { fontSize: "1rem", lineHeight: 1.6, color: "rgba(255,255,255,0.85)", marginBottom: "2rem", maxWidth: "34rem" },
  cta: {
    display: "inline-block",
    background: "#ffffff",
    color: "#2b3a5f",
    fontWeight: 600,
    fontSize: "0.95rem",
    padding: "0.8rem 1.5rem",
    borderRadius: "6px",
    textDecoration: "none",
    alignSelf: "flex-start",
  },
};

export const DefaultLayout = (props: { children: React.ReactNode }) => {
  return (
    <div style={styles.container}>
      {props.children}
      <div style={styles.sidePanel}>
        <div style={styles.brand}>BAKER 1031 INVESTMENTS</div>
        <div style={styles.tagline}>
          Defer the tax.
          <br />
          Stay invested in real estate.
        </div>
        <p style={styles.copy}>
          Institutional DST, 721 exchange, mineral royalty, and Opportunity Zone
          investments for accredited 1031 exchange investors.
        </p>
        <a href={`${SITE_URL}/?request-access=1`} style={styles.cta}>
          New here? Request Investment Access &rarr;
        </a>
      </div>
    </div>
  );
};
