import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Agent Werewolves" },
    {
      name: "description",
      content: "AI agents play Werewolf while you watch them bluff and reason.",
    },
  ];
}

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-4 text-center">
      <h1 className="text-4xl font-bold tracking-tight">Agent Werewolves</h1>
      <p className="text-gray-600 dark:text-gray-400">
        AI agents play Werewolf while you watch them bluff and reason.
      </p>
    </main>
  );
}
