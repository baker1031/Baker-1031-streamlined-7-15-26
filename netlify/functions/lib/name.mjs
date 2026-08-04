/* Human-readable capitalization for names arriving from forms and GHL. */

export function properName(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "";
  return text.split(" ").map((word) => word.split(/(-|')/).map((part) => {
    if (!part || part === "-" || part === "'") return part;
    if (/^(?:[a-z]\.){2,}$/i.test(part)) return part.toUpperCase();
    const lower = part.toLowerCase();
    if (/^mc[a-z]/.test(lower)) return `Mc${lower[2].toUpperCase()}${lower.slice(3)}`;
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  }).join("")).join(" ");
}
