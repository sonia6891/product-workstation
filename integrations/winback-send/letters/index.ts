// product_id (as in the workstation) → its letter, per campaign. A product with no letter cannot be sent to.
import type { Letter } from "./types.ts";
import { meowWork } from "./meow-work.ts";

export const LETTERS: Record<string, Record<string, Letter>> = {
  "meow-work": { "winback-1": meowWork },
};
