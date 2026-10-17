import { login } from "@/features/auth/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return (
    <>
      <h1>Sign in</h1>
      {error && <p className="error">{error}</p>}
      <form action={login}>
        <input name="email" type="email" required placeholder="you@example.com" />
        <button type="submit">Continue</button>
      </form>
    </>
  );
}
