-- Global book metadata cache. Keyed by cache_key (priority: isbn_13, google_books_id, open_library_work_id, work_key).
-- Never allow user deletes to touch this table (application code must not delete; RLS can restrict deletes).
CREATE TABLE IF NOT EXISTS book_metadata_cache (
  cache_key TEXT PRIMARY KEY,
  description TEXT,
  publisher TEXT,
  published_date TEXT,
  page_count INT,
  categories JSONB,
  language TEXT,
  subtitle TEXT,
  isbn TEXT,
  average_rating NUMERIC,
  ratings_count INT,
  google_books_id TEXT,
  open_library_work_id TEXT,
  source TEXT NOT NULL DEFAULT 'open_library' CHECK (source IN ('open_library', 'google_books')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_book_metadata_cache_updated_at ON book_metadata_cache(updated_at);

-- Optional: prevent deletes from anon/authenticated roles so only service role can manage cache
-- ALTER TABLE book_metadata_cache ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "no delete book_metadata_cache" ON book_metadata_cache FOR DELETE USING (false);
