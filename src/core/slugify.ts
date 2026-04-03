/**
 * Transliterate accented characters to ASCII and create a URL-safe slug.
 * "Eu Áustria" → "eu-austria", "Apolinário Passos" → "apolinario-passos"
 */
export function slugify(name: string): string {
  return name
    .normalize("NFD")                   // decompose accents: á → a + combining accent
    .replace(/[\u0300-\u036f]/g, "")    // strip combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")        // non-alphanumeric → single hyphen
    .replace(/^-|-$/g, "");             // trim leading/trailing hyphens
}
