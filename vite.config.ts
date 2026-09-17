import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    {
      name: "development-csp",
      transformIndexHtml: {
        order: "pre",
        handler(html, ctx) {
          // React's development preamble is inline. Keep the strict policy in
          // every production build; dev-only removal is not a release bypass.
          return ctx.server ? html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "") : html;
        },
      },
    },
    react(), tailwindcss(),
  ],
  server: {
    host: "0.0.0.0",
    hmr: false,
  },
});
