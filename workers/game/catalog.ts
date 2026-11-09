/**
 * The models and personalities a seat may use. Every model here must stay
 * priced under the engine's rate ceilings and pass `npm run smoke:models`.
 */
export type CatalogModel = {
  id: string;
  label: string;
  lab: string;
  /** `null` omits `temperature`: these models reject it, and requests require every parameter. */
  temperature: number | null;
};

export const MODELS: readonly CatalogModel[] = [
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash Lite", lab: "Google", temperature: 0.7 },
  { id: "anthropic/claude-haiku-5.5", label: "Claude Haiku 5.5", lab: "Anthropic", temperature: null },
  { id: "openai/gpt-6-luna", label: "GPT-6 Luna", lab: "OpenAI", temperature: null },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", lab: "DeepSeek", temperature: 0.7 },
  { id: "qwen/qwen3.8-flash", label: "Qwen 3.8 Flash", lab: "Qwen", temperature: 0.7 },
  { id: "mistralai/mistral-small-2603", label: "Mistral Small", lab: "Mistral", temperature: 0.7 },
];

export type Persona = { id: string; name: string; prompt: string };

/**
 * Play-style personalities, reviewed by the operator 2026-11-09. Ids are stored
 * in archived games: keep them stable; a retired id still renders as its id.
 */
export const PERSONAS: readonly Persona[] = [
  { id: "analyst", name: "The Analyst", prompt: "You reason from evidence. You track who said what and point out contradictions calmly." },
  { id: "accuser", name: "The Accuser", prompt: "You are bold and quick to name suspects. You push the table to act rather than wait." },
  { id: "diplomat", name: "The Diplomat", prompt: "You build consensus. You restate others' views fairly and look for a vote most people accept." },
  { id: "contrarian", name: "The Contrarian", prompt: "You distrust the majority. You defend whoever is being piled on and test the strongest argument." },
  { id: "storyteller", name: "The Storyteller", prompt: "You explain your suspicions as vivid stories that connect what players said and how they voted." },
  { id: "cautious", name: "The Cautious One", prompt: "You avoid early commitments, hedge your claims, and change your mind only with good reason." },
  { id: "loyalist", name: "The Loyalist", prompt: "You pick the player you trust most early and stand by them. You defend your allies and turn on them only with strong evidence." },
  { id: "logician", name: "The Logician", prompt: "You count. You track how many wolves can remain, who voted for whom, and which claims cannot all be true." },
  { id: "instigator", name: "The Instigator", prompt: "You stir things up with provocative claims to see who reacts, and you watch the reactions closely." },
];

export function modelById(id: string): CatalogModel | undefined {
  return MODELS.find(m => m.id === id);
}

export function personaById(id: string): Persona | undefined {
  return PERSONAS.find(p => p.id === id);
}

/** Display label for a model id, including ids no longer in the catalog. */
export function modelLabel(id: string): string {
  return id === "mixed" ? "Mixed models" : modelById(id)?.label ?? id;
}
