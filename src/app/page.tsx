import Link from "next/link";

export default function Home() {
  return (
    <>
      <h1>Purpose Learning</h1>
      <p>Learn on purpose.</p>
      <Link href="/pricing">See plans</Link>
    </>
  );
}
