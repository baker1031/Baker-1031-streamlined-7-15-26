/* Build-time partial injection: replaces the content between
   <!-- PARTIAL:name --> ... <!-- /PARTIAL:name --> with partials/<name>.html.
   Pages keep the last-baked copy between markers, so they stay previewable
   locally; editing a partial updates every page on the next build. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function injectPartials(html, root, file = "") {
  return html.replace(
    /<!-- PARTIAL:([\w-]+) -->[\s\S]*?<!-- \/PARTIAL:\1 -->/g,
    (m, name) => {
      const partial = readFileSync(join(root, "partials", `${name}.html`), "utf8").trim();
      return `<!-- PARTIAL:${name} -->\n${partial}\n<!-- /PARTIAL:${name} -->`;
    }
  );
}
