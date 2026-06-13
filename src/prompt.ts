import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(message: string): Promise<boolean> {
  const answer = (await prompt(`${message} [y/N] `)).toLowerCase();
  return answer === "y" || answer === "yes";
}
