/**
 * The legal footer, shared by every panel that should carry it.
 *
 * Plain anchors with `target="_blank"`, not in-app routes: /terms.html and
 * /privacy.html are dependency-free static files in web/public/ (see the
 * comment at the top of either one), so following one is a real navigation.
 * Opening in a new tab is what keeps that from throwing away whatever the
 * player had half-finished in the panel behind it — a part-typed signup, a
 * chosen-but-unsaved profile picture.
 *
 * The `.html` is deliberate. Caddy also serves these at the bare /terms and
 * /privacy in production, but Vite's dev server does not, so linking to the
 * extensionless form would give a 404 in dev and work in prod — the worst
 * possible split for a link nobody clicks during normal development.
 */
export function LegalFooter() {
  return (
    <footer className="cp-legal-footer">
      <a href="/terms.html" target="_blank" rel="noreferrer">
        Terms
      </a>
      <span aria-hidden="true">·</span>
      <a href="/privacy.html" target="_blank" rel="noreferrer">
        Privacy
      </a>
    </footer>
  );
}
