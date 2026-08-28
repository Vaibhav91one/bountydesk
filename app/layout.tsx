import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "./globals.css";
import { MascotLoader } from "@/components/mascot-loader";
import { SitePreloader } from "@/components/site-preloader";
import { cn } from "@/lib/utils";

// One family for the whole product. Inter is variable, so a single file covers 400 to 600 and
// hierarchy can be carried by weight rather than by size alone.
const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BountyDesk",
  description:
    "Automated bug-bounty triage: reproduce a report against a pinned target, ship a verdict only after a human approves it.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  // "dark" is not cosmetic: the design system's tokens are defined under .dark in
  // globals.css, so without it the palette falls back to light and the theme is inert.
  // The product has one theme; a switcher can come when it needs two.
  return (
    <html
      lang="en"
      className={cn(
        "dark",
        "h-full",
        "antialiased",
        "font-sans",
        inter.variable,
        geistMono.variable,
      )}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* Rendered on the server so it covers the page from the first paint, before any of
            this app's JavaScript has run. */}
        <SitePreloader>
          <MascotLoader />
        </SitePreloader>
      </body>
    </html>
  );
}
