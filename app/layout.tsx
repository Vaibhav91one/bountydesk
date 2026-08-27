import type { Metadata } from "next";
import { Geist, Geist_Mono, Inter, Questrial } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const inter = Inter({subsets:['latin'],variable:'--font-sans'});

// The display face, mapped to --font-heading in globals.css. Questrial ships one weight,
// so headings and the wordmark use it and anything that needs a bold stays on Inter.
const questrial = Questrial({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-questrial",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

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
        geistSans.variable,
        geistMono.variable,
        "font-sans",
        inter.variable,
        questrial.variable,
      )}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
