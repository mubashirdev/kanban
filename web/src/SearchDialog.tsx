import { useEffect, useState } from "react";
import { api, type SearchHit } from "./api";
import { Modal } from "./Modal";

const FIELD_LABEL: Record<SearchHit["field"], string> = { title: "Title", description: "Description", comment: "Comment", message: "Conversation" };

/** Full-text search over a board's tickets and chats: titles, descriptions, comments and what was said. */
export function SearchDialog({ slug, onClose, onPick }: { slug: string; onClose: () => void; onPick: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState("");
  const words = query.trim();

  useEffect(() => {
    if (!words) return setHits(null);
    // Wait for a pause in typing, and ignore answers to an older query.
    let current = true;
    const timer = setTimeout(() => {
      api.search(slug, words).then((r) => { if (current) { setHits(r); setError(""); } }, (e) => { if (current) setError(e.message); });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [slug, words]);

  return (
    <Modal title="Search tickets and chats" onClose={onClose}>
      <div className="form search-form">
        <input type="search" autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Words from a title, comment or conversation…" aria-label="Search tickets and chats" />
        {error && <div className="form-error">{error}</div>}
        {hits?.length === 0 && <p className="muted small">Nothing found for “{words}”.</p>}
        {hits && hits.length > 0 && (
          <div className="sheet-list search-hits">
            {hits.map((h) => (
              <button key={h.id} type="button" className="sheet-action inbox-row" onClick={() => onPick(h.id)}>
                <span className="inbox-row-title">{h.title}</span>
                <span className="muted small search-hit-where">{h.standalone ? "Chat" : "Ticket"} · {FIELD_LABEL[h.field]}</span>
                {h.field !== "title" && <span className="search-hit-snippet">{h.snippet}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
