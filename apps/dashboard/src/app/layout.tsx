import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notify Engine",
  description: "Notification infrastructure for developers.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
