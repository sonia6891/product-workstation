// One 挽回信 per product. {{TOKEN}} in html is replaced by the person's token; text(t) is the plain-text version.
export type Letter = {
  fromName: string;          // shown before <sonia@pocketjoystudio.com>
  subject: string;
  images: Record<string, string>; // content id → public URL; attached inline so they show without "load images"
  text: (token: string) => string;
  html: string;
};
