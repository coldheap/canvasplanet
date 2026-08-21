/**
 * The phone composition breakpoint, in one place.
 *
 * styles.css switches the whole interface to its two-row phone layout — and
 * hides the pixel inspector outright — at this exact query. A couple of
 * behaviours have to agree with that decision rather than guess at it: there
 * is no point spending a request per hover fetching data for a panel the
 * stylesheet is not going to render.
 *
 * Keep this string and the matching `@media` rules in styles.css together.
 */
export const PHONE_LAYOUT_QUERY = "(max-width: 640px), (max-width: 950px) and (max-height: 500px)";

import { useEffect, useState } from "react";

/** A finger rather than a cursor — a phone or a tablet, whatever its width. */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** Subscribe to a media query. Follows rotation and resize. */
export function useMediaQuery(query: string): boolean {
  const [active, setActive] = useState(() => matches(query));

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setActive(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return active;
}

/** True while the phone composition is active. */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_LAYOUT_QUERY);
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}
