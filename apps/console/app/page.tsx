import { Chat } from "./chat";

export default function Home() {
  return (
    <main>
      <h1>Agent console</h1>
      <p className="lede">
        Talks to the local Hono server through /api/turn. No model key needed for the mock.
      </p>
      <Chat />
    </main>
  );
}
