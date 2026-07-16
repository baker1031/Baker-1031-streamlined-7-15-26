import React from "react";

const SITE_URL = "https://streamlined-baker-1031.netlify.app"; // swap for baker1031.com at launch

// San Francisco skyline (Jerry-supplied), served from *.baker1031.com for Kinde's CSP
const SKYLINE = "https://assets.baker1031.com/assets/login-skyline-sf.webp";

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "3rem 1rem",
    boxSizing: "border-box",
    backgroundColor: "#2b3a5f",
    backgroundImage: `linear-gradient(rgba(30, 42, 71, 0.28), rgba(30, 42, 71, 0.38)), url(${SKYLINE})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  },
  card: {
    width: "min(92vw, 26.5rem)",
    background: "#ffffff",
    borderRadius: "12px",
    boxShadow: "0 18px 48px rgba(9, 14, 26, 0.45)",
    padding: "2.4rem 2.4rem 2.1rem",
    boxSizing: "border-box",
  },
};

export const DefaultLayout = (props: { children: React.ReactNode }) => {
  return (
    <div style={styles.page}>
      <div style={styles.card}>{props.children}</div>
    </div>
  );
};
