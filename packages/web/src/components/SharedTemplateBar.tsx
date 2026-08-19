/**
 * The bar shown when the page was opened from a /t/:id share link.
 *
 * Carries the report button. Templates are unlisted — link only, no directory
 * — so the only people who can find a bad one are the people it was shared
 * with. Without a report control right here, that means nobody can.
 */

import { useState } from "react";
import { Check, Flag, LayoutTemplate, X } from "lucide-react";
import { api } from "../api.js";
import { useStore } from "../store.js";
import type { MapHandle } from "./MapCanvas.js";

export function SharedTemplateBar({ handle }: { handle: MapHandle | null }) {
  const id = useStore((s) => s.sharedTemplateId);
  const [reported, setReported] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!id) return null;

  return (
    <div className="cp-shared-bar cp-card" role="status">
      <LayoutTemplate size={15} />
      <span>Someone shared a template with you — paint over the ghost.</span>

      <button
        className="cp-btn"
        disabled={busy || reported}
        title="Report this template"
        onClick={async () => {
          setBusy(true);
          try {
            await api.reportTemplate(id);
            setReported(true);
          } finally {
            setBusy(false);
          }
        }}
      >
        {reported ? <Check size={14} /> : <Flag size={14} />}
        {reported ? "Reported" : "Report"}
      </button>

      <button
        className="cp-btn"
        aria-label="Dismiss"
        onClick={() => {
          handle?.template.set(null);
          useStore.setState({ sharedTemplateId: null });
          // Drop /t/:id from the URL so a refresh does not reload it, but
          // keep the map position hash the user has since navigated to.
          history.replaceState(null, "", `/${location.hash}`);
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}
