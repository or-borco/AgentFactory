export function sandboxModelEnv(): Record<string, string> {
  return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "" };
}
