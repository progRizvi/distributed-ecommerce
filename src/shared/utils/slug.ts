// "Men's Shoes & Boots" -> "mens-shoes-boots". Letters with accents lose the accent (é -> e).
// Returns '' when nothing usable is left (for example a name written only in Bangla): the caller must
// ask for a slug in that case.
export function slugify(text: string, maxLength = 100): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

// Lowercase words joined by single dashes. This is what a slug in a URL must look like.
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
