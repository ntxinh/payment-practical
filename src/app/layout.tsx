import type { ReactNode } from "react";
import "./globals.css";

export const metadata = { title: "Purpose Learning" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="wrap">{children}</main>
      </body>
    </html>
  );
}
