/**
 * Renders a country flag as an SVG (flag-icons), not emoji.
 *
 * Windows has no font support for the regional-indicator character pairs
 * that make up a flag emoji (e.g. U+1F1FA U+1F1F8 for 🇺🇸) — it shows the
 * bare two-letter code instead of a flag. `flag-icons` sidesteps that by
 * drawing the flag as a CSS background image keyed off the ISO code.
 *
 * `flag` is only truthy for entities with no real ISO code (Natural Earth
 * rows without an ISO_A2/ISO_A2_EH/WB_A2 match — see source.ts), in which
 * case the server already sends the white-flag placeholder glyph, which
 * *is* a single ordinary emoji and renders fine everywhere.
 */
export function CountryFlag({
  iso,
  flag,
  className,
}: {
  iso?: string | null;
  flag?: string | null;
  className?: string;
}) {
  const code = iso && /^[A-Za-z]{2}$/.test(iso) ? iso.toLowerCase() : null;
  if (!flag && code) {
    return <span className={["fi", `fi-${code}`, className].filter(Boolean).join(" ")} aria-hidden />;
  }
  return (
    <span className={className} aria-hidden>
      {flag || "🏳️"}
    </span>
  );
}
