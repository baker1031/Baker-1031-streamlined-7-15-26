import React from "react";
import { getDarkModeLogoUrl } from "@kinde/infrastructure";

const SITE_URL = "https://streamlined-baker-1031.netlify.app"; // swap for baker1031.com at launch

// Navy-duotone skyline (frame pulled from the homepage hero video via Cloudinary)
const SKYLINE =
  "https://res.cloudinary.com/opoazlei/video/upload/so_2,w_1920,h_1080,c_fill,g_north,q_auto,f_jpg/Baker_1031_Homepage_Video_q9k7ca.jpg";

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "4.5rem 1rem 3rem",
    boxSizing: "border-box",
    backgroundColor: "#2b3a5f",
    backgroundImage: `linear-gradient(rgba(58, 76, 120, 0.62), rgba(36, 49, 82, 0.78)), url(${SKYLINE})`,
    backgroundBlendMode: "multiply",
    backgroundSize: "cover",
    backgroundPosition: "center top",
    backgroundRepeat: "no-repeat",
  },
  cardWrap: {
    position: "relative",
    width: "min(92vw, 26.5rem)",
  },
  plaque: {
    position: "absolute",
    top: "-3.1rem",
    left: "50%",
    transform: "translateX(-50%)",
    background: "linear-gradient(160deg, #2b3a5f 0%, #1e2a47 100%)",
    border: "1px solid rgba(255,255,255,0.85)",
    boxShadow: "0 10px 24px rgba(9, 14, 26, 0.45)",
    padding: "1.1rem 1.4rem",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  plaqueImg: {
    width: "11.5rem",
    height: "auto",
    display: "block",
  },
  card: {
    position: "relative",
    background: "#fbfbfc",
    boxShadow: "0 18px 48px rgba(9, 14, 26, 0.5)",
    padding: "4.4rem 2.4rem 2.1rem",
    boxSizing: "border-box",
  },
};

export const DefaultLayout = (props: { children: React.ReactNode }) => {
  return (
    <div style={styles.page}>
      <div style={styles.cardWrap}>
        <a href={SITE_URL} style={styles.plaque} aria-label="Baker 1031 Investments">
          <img
            src={getDarkModeLogoUrl()}
            alt="Baker 1031 Investments"
            style={styles.plaqueImg}
          />
        </a>
        <div style={styles.card}>{props.children}</div>
      </div>
    </div>
  );
};
