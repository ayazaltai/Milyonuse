import type { Dictionary } from '@/i18n';

interface LegalDocument {
  title: string;
  sections: { heading: string; body: string }[];
}

/** A legal page: its title, the draft notice until counsel has reviewed it, its sections. */
export function LegalPage({ document, t, updated }: { document: LegalDocument; t: Dictionary; updated: string }) {
  return (
    <article className="mk-legal">
      <h1 className="mk-serif">{document.title}</h1>
      <p className="mk-legal-draft" role="note">
        {t.common.draftNotice}
      </p>
      <p style={{ marginTop: 16, fontSize: 13 }}>
        {t.legal.updated}: <time dateTime={updated}>{updated}</time>
      </p>
      {document.sections.map((section) => (
        <section key={section.heading}>
          <h2>{section.heading}</h2>
          <p>{section.body}</p>
        </section>
      ))}
    </article>
  );
}
