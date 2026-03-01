'use strict';

// File extension → tech interest label
const EXT_MAP = {
  '.js':    'JavaScript',
  '.ts':    'TypeScript',
  '.tsx':   'React',
  '.jsx':   'React',
  '.py':    'Python',
  '.rs':    'Rust',
  '.go':    'Go',
  '.swift': 'Swift',
  '.rb':    'Ruby',
  '.kt':    'Kotlin',
  '.java':  'Java',
  '.cs':    'C#',
  '.cpp':   'C++',
  '.c':     'C',
  '.vue':   'Vue',
  '.svelte': 'Svelte',
  '.elm':   'Elm',
  '.ex':    'Elixir',
  '.exs':   'Elixir',
  '.hs':    'Haskell',
  '.ml':    'OCaml',
  '.clj':   'Clojure',
  '.sh':    'DevOps',
  '.yaml':  'DevOps',
  '.yml':   'DevOps',
  '.tf':    'DevOps',
  '.dockerfile': 'DevOps',
};

class InterestManager {
  constructor(db) {
    this.db = db;
  }

  /**
   * Scan recent file_save activity for this project and derive interest tags
   * from file extensions.
   */
  deriveFromProject(projectId) {
    if (!projectId) return [];
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.db.prepare(`
      SELECT metadata FROM activity
      WHERE project_id = ? AND event_type = 'file_save' AND timestamp > ?
    `).all(projectId, cutoff);

    const counts = new Map();
    for (const row of rows) {
      try {
        const { path } = JSON.parse(row.metadata || '{}');
        if (!path) continue;
        const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
        const interest = EXT_MAP[ext];
        if (interest) counts.set(interest, (counts.get(interest) || 0) + 1);
      } catch {}
    }

    // Return interests that appear at least twice (reduce noise)
    return [...counts.entries()]
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([interest]) => interest);
  }

  /**
   * Load manually set interests from app_state.
   */
  getManual() {
    const raw = this.db.getState('user_interests');
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /**
   * Persist manually set interests to app_state.
   */
  setManual(topics) {
    const cleaned = [...new Set(
      (Array.isArray(topics) ? topics : [])
        .map(t => String(t).trim())
        .filter(Boolean)
    )];
    this.db.setState('user_interests', JSON.stringify(cleaned));
  }

  /**
   * Merge auto-derived (from project files) + manual interests, deduped.
   */
  getEffective(projectId) {
    const derived = this.deriveFromProject(projectId);
    const manual  = this.getManual();
    return [...new Set([...derived, ...manual])];
  }
}

module.exports = InterestManager;
