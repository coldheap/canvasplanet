/**
 * Server-side chat profanity filter.
 *
 * This intentionally lives on the server: a browser-only filter is bypassed
 * by one HTTP request. Matching is Unicode/diacritic normalised, understands
 * common leetspeak substitutions, and tolerates punctuation between letters.
 * Word boundaries keep short entries from censoring innocent substrings.
 */

const BLOCKED_TERMS = [
  // General profanity / sexual harassment.
  "asshole", "arsehole", "bastard", "bitch", "bollocks", "bullshit", "cocksucker",
  "cunt", "dickhead", "dumbass", "fag", "faggot", "fuck", "fucker", "fucking",
  "jackass", "motherfucker", "prick", "pussy", "shit", "shithead", "slut", "twat",
  "whore", "wanker", "rape", "rapist", "molest", "pedophile", "paedophile",
  "child porn", "kys", "kill yourself", "go die",

  // Racial, ethnic, religious, national-origin and caste slurs.
  "nigger", "nigga", "negro", "coon", "darkie", "jigaboo", "pickaninny", "sambo",
  "porch monkey", "cotton picker", "blackie", "wetback", "beaner", "spic", "spick",
  "greaser", "border hopper", "zipperhead", "gook", "chink", "ching chong", "slant eye",
  "yellow peril", "jap", "nip", "paki", "curry muncher", "raghead", "towelhead",
  "sand nigger", "camel jockey", "kike", "heeb", "yid", "christ killer", "oven dodger",
  "gypsy", "gyppo", "pikey", "redskin", "injun", "prairie nigger", "squaw", "abo",
  "coonass", "wog", "kaffir", "kafir", "coolie", "slopehead", "rice monkey",
  "white trash", "hillbilly", "cracker", "honky", "polack", "dago", "guido",
  "mick", "kraut", "hymie", "shylock", "bamboo coon", "jungle bunny",

  // Anti-LGBTQ+ and gendered slurs.
  "dyke", "lesbo", "tranny", "shemale", "he she", "gender freak", "homo",
  "fairy", "fruitcake", "queer bait", "sodomite", "ladyboy", "troon",

  // Disability and health-related slurs.
  "retard", "retarded", "window licker", "mongoloid", "mong", "spastic", "cripple",
  "lamebrain", "psycho", "schizo", "autist", "autistic screeching", "downie",
  "short bus", "vegetable", "invalid",

  // Supremacist and extermination slogans commonly used as direct abuse.
  "white power", "white lives matter", "heil hitler", "sieg heil", "gas the jews",
  "gas the gays", "race war", "ethnic cleansing", "exterminate muslims",
  "exterminate jews", "exterminate gays", "death to muslims", "death to jews",
  "death to gays", "deus vult",
] as const;

const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "9": "g",
  "@": "a",
  "$": "s",
};

// Common cross-script lookalikes used to evade Latin moderation filters.
const HOMOGLYPH: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "і": "i", "ј": "j", "о": "o", "р": "p",
  "с": "c", "х": "x", "у": "y", "κ": "k", "ν": "v", "ο": "o",
};

interface Canonical {
  text: string;
  /** Original UTF-16 span for each canonical character. */
  spans: Array<{ start: number; end: number }>;
}

function canonicalize(input: string): Canonical {
  let text = "";
  const spans: Canonical["spans"] = [];
  let offset = 0;

  for (const sourceChar of input) {
    const start = offset;
    offset += sourceChar.length;
    const normalized = sourceChar.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (const normalizedChar of normalized) {
      const mapped = LEET[normalizedChar] ?? HOMOGLYPH[normalizedChar] ?? normalizedChar;
      text += mapped;
      // RegExp match.index is a UTF-16 offset. Mirror every code unit here
      // (astral emoji use two) so a match after emoji maps back correctly.
      for (let i = 0; i < mapped.length; i += 1) spans.push({ start, end: offset });
    }
  }
  return { text, spans };
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FILTER_PATTERN = (() => {
  const alternatives = [...new Set(BLOCKED_TERMS.map((term) =>
    canonicalize(term).text.replace(/[^a-z0-9]/g, ""),
  ))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((term) => [...term].map((char) => `${regexEscape(char)}+`).join("[^a-z0-9]*"));
  return new RegExp(`(?<![a-z0-9])(?:${alternatives.join("|")})(?![a-z0-9])`, "gu");
})();

/** Replace every blocked span with five asterisks while leaving the rest of
 * the original (including emoji and non-English text) byte-for-byte intact. */
export function censorChatMessage(input: string): string {
  const canonical = canonicalize(input);
  const ranges: Array<{ start: number; end: number }> = [];

  FILTER_PATTERN.lastIndex = 0;
  for (const match of canonical.text.matchAll(FILTER_PATTERN)) {
    const first = match.index;
    const last = first + match[0].length - 1;
    const start = canonical.spans[first]?.start;
    const end = canonical.spans[last]?.end;
    if (start === undefined || end === undefined) continue;
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  if (ranges.length === 0) return input;
  let result = "";
  let cursor = 0;
  for (const range of ranges) {
    result += input.slice(cursor, range.start) + "*****";
    cursor = range.end;
  }
  return result + input.slice(cursor);
}

export const CHAT_MAX_LENGTH = 400;
export const CHAT_COOLDOWN_MS = 100;
export const CHAT_PAGE_SIZE = 50;
