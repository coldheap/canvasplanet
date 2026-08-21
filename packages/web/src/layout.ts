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

/** True while the phone composition is active. Follows rotation and resize. */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(() => matches(PHONE_LAYOUT_QUERY));

  useEffect(() => {
    const query = window.matchMedia(PHONE_LAYOUT_QUERY);
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return phone;
}

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}
