import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Agent console",
  description: "Local console for the turbo-agent-kit server",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
