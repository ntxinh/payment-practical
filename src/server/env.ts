import "server-only";

export function appUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function sessionSecret(): string {
  return process.env.SESSION_SECRET ?? "dev-only-insecure-secret";
}

export function dbPath(): string {
  return (process.env.DATABASE_URL ?? "file:./data/app.db").replace(/^file:/, "");
}
