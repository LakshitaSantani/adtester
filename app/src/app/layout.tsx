import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Simply Why",
  description: "What changed, why it changed, and what to do about it.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
