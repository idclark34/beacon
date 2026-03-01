'use strict';

const path = require('path');
const { app } = require('electron');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('better-sqlite3 not found. Run: npm run rebuild');
  process.exit(1);
}

class DB {
  constructor() {
    const userDataPath = app ? app.getPath('userData') : path.join(__dirname, '..');
    this.dbPath = path.join(userDataPath, 'outpost.db');
    this.db = null;
  }

  initialize() {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    console.log(`[DB] Initialized at ${this.dbPath}`);
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        repo_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        event_type TEXT NOT NULL,
        metadata TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        message TEXT NOT NULL,
        sender TEXT NOT NULL,
        context TEXT,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS manual_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        goal_text TEXT NOT NULL,
        week_start DATE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS app_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS feed_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT UNIQUE,
        description TEXT,
        relevance_score REAL DEFAULT 0,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        surfaced_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_activity_project_time
        ON activity(project_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_conversations_project_time
        ON conversations(project_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_feed_unsurfaced
        ON feed_items(surfaced_at, relevance_score);

      CREATE TABLE IF NOT EXISTS spend_snapshots (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        period      TEXT NOT NULL,
        total_cost  REAL NOT NULL,
        fetched_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_spend_period
        ON spend_snapshots(period, fetched_at DESC);
    `);
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  getProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
  }

  getProject(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  }

  addProject({ name, repo_path }) {
    const stmt = this.db.prepare(
      'INSERT INTO projects (name, repo_path) VALUES (?, ?)'
    );
    const result = stmt.run(name, repo_path || null);
    return this.getProject(result.lastInsertRowid);
  }

  updateProject(id, { name, repo_path }) {
    this.db.prepare(
      'UPDATE projects SET name = ?, repo_path = ? WHERE id = ?'
    ).run(name, repo_path, id);
    return this.getProject(id);
  }

  // ── Activity ──────────────────────────────────────────────────────────────

  logActivity(projectId, eventType, metadata = {}) {
    this.db.prepare(
      'INSERT INTO activity (project_id, event_type, metadata) VALUES (?, ?, ?)'
    ).run(projectId, eventType, JSON.stringify(metadata));
  }

  getRecentActivity(projectId, hoursBack = 24) {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT * FROM activity
      WHERE project_id = ? AND timestamp > ?
      ORDER BY timestamp DESC
    `).all(projectId, cutoff);
  }

  getCommitCountSince(projectId, since) {
    const isoSince = since instanceof Date ? since.toISOString() : since;
    const rows = this.db.prepare(`
      SELECT metadata FROM activity
      WHERE project_id = ? AND event_type = 'commit' AND timestamp > ?
    `).all(projectId, isoSince);

    return rows.reduce((total, row) => {
      try {
        const meta = JSON.parse(row.metadata || '{}');
        return total + (meta.count || 0);
      } catch {
        return total;
      }
    }, 0);
  }

  getActiveMinutesSince(projectId, since) {
    const isoSince = since instanceof Date ? since.toISOString() : since;
    const count = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM activity
      WHERE project_id = ? AND event_type = 'active_coding' AND timestamp > ?
    `).get(projectId, isoSince);
    return (count?.cnt || 0) * 5; // each row = 5 min window
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  saveConversation(projectId, message, sender, context = null) {
    this.db.prepare(`
      INSERT INTO conversations (project_id, message, sender, context)
      VALUES (?, ?, ?, ?)
    `).run(projectId, message, sender, context ? JSON.stringify(context) : null);
  }

  getConversations(projectId, limit = 10) {
    return this.db.prepare(`
      SELECT * FROM conversations
      WHERE project_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(projectId, limit).reverse();
  }

  getAllConversations(limit = 50) {
    return this.db.prepare(`
      SELECT * FROM conversations
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit).reverse();
  }

  // ── Goals ─────────────────────────────────────────────────────────────────

  addGoal(projectId, goalText) {
    const weekStart = this._getWeekStart();
    this.db.prepare(`
      INSERT INTO manual_goals (project_id, goal_text, week_start)
      VALUES (?, ?, ?)
    `).run(projectId, goalText, weekStart);
  }

  getActiveGoals(projectId) {
    const weekStart = this._getWeekStart();
    return this.db.prepare(`
      SELECT * FROM manual_goals
      WHERE project_id = ? AND week_start = ?
      ORDER BY created_at ASC
    `).all(projectId, weekStart);
  }

  _getWeekStart() {
    const now = new Date();
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(now.setDate(diff));
    return monday.toISOString().split('T')[0];
  }

  // ── App State ─────────────────────────────────────────────────────────────

  getState(key) {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
    return row ? row.value : null;
  }

  setState(key, value) {
    this.db.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, String(value));
  }

  getHotFiles(projectId, hoursBack = 8, limit = 3) {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT metadata FROM activity
      WHERE project_id = ? AND event_type = 'file_save' AND timestamp > ?
    `).all(projectId, cutoff);
    const counts = new Map();
    for (const row of rows) {
      try {
        const { path } = JSON.parse(row.metadata || '{}');
        if (path) counts.set(path, (counts.get(path) || 0) + 1);
      } catch {}
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([filePath, saveCount]) => ({ filePath, saveCount }));
  }

  getMultiDaySummary(projectId, days = 7) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const commitRows = this.db.prepare(`
      SELECT metadata FROM activity
      WHERE project_id = ? AND event_type = 'commit' AND timestamp > ?
    `).all(projectId, cutoff);
    const totalCommits = commitRows.reduce((sum, row) => {
      try { return sum + (JSON.parse(row.metadata || '{}').count || 0); }
      catch { return sum; }
    }, 0);

    const activeCount = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM activity
      WHERE project_id = ? AND event_type = 'active_coding' AND timestamp > ?
    `).get(projectId, cutoff);
    const activeHours = Math.round(((activeCount?.cnt || 0) * 5) / 60 * 10) / 10;

    const activeDaysRow = this.db.prepare(`
      SELECT COUNT(DISTINCT date(timestamp)) as cnt FROM activity
      WHERE project_id = ? AND event_type = 'active_coding' AND timestamp > ?
    `).get(projectId, cutoff);
    const activeDays = activeDaysRow?.cnt || 0;

    const fileRows = this.db.prepare(`
      SELECT metadata FROM activity
      WHERE project_id = ? AND event_type = 'file_save' AND timestamp > ?
    `).all(projectId, cutoff);
    const fileCounts = new Map();
    for (const row of fileRows) {
      try {
        const { path } = JSON.parse(row.metadata || '{}');
        if (path) fileCounts.set(path, (fileCounts.get(path) || 0) + 1);
      } catch {}
    }
    const topFiles = [...fileCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([filePath, saveCount]) => ({ filePath, saveCount }));

    return { days, totalCommits, activeHours, activeDays, topFiles };
  }

  // ── Feed Items ────────────────────────────────────────────────────────────

  saveFeedItem({ source, title, url, description, score }) {
    try {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO feed_items (source, title, url, description, relevance_score)
        VALUES (?, ?, ?, ?, ?)
      `).run(source, title, url || null, description || null, score || 0);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  getUnsurfacedFeedItems(minScore = 0, limit = 5) {
    return this.db.prepare(`
      SELECT * FROM feed_items
      WHERE surfaced_at IS NULL AND relevance_score >= ?
      ORDER BY relevance_score DESC, fetched_at DESC
      LIMIT ?
    `).all(minScore, limit);
  }

  markFeedItemsSurfaced(ids) {
    if (!ids?.length) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`
      UPDATE feed_items SET surfaced_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).run(...ids);
  }

  pruneOldFeedItems() {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      DELETE FROM feed_items WHERE fetched_at < ?
    `).run(cutoff);
  }

  // ── Spend Snapshots ───────────────────────────────────────────────────────

  saveSpendSnapshot(period, totalCost) {
    this.db.prepare(
      'INSERT INTO spend_snapshots (period, total_cost) VALUES (?, ?)'
    ).run(period, totalCost);
  }

  getLatestSpendSnapshot(period) {
    return this.db.prepare(`
      SELECT * FROM spend_snapshots
      WHERE period = ?
      ORDER BY fetched_at DESC
      LIMIT 1
    `).get(period);
  }

  getSpendSnapshots(period) {
    return this.db.prepare(`
      SELECT * FROM spend_snapshots
      WHERE period = ?
      ORDER BY fetched_at ASC
    `).all(period);
  }

  // ── New query methods ─────────────────────────────────────────────────────

  getLastActivityTime() {
    const row = this.db.prepare(`
      SELECT timestamp FROM activity
      WHERE event_type = 'active_coding'
      ORDER BY timestamp DESC LIMIT 1
    `).get();
    return row ? row.timestamp : null;
  }

  getActiveProjectIds(hoursBack) {
    const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT DISTINCT project_id FROM activity
      WHERE event_type IN ('file_save', 'active_coding')
        AND timestamp > ?
    `).all(cutoff);
    return rows.map(r => r.project_id);
  }

  getMultiProjectPattern(days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT project_id,
        SUM(CASE WHEN event_type = 'commit' THEN 1 ELSE 0 END) as commit_events,
        COUNT(DISTINCT date(timestamp)) as active_days
      FROM activity
      WHERE timestamp > ?
      GROUP BY project_id
    `).all(cutoff);
  }

  // ── Activity Summary (privacy-safe) ───────────────────────────────────────

  getActivitySummary(projectId, hoursBack = 24) {
    const recent = this.getRecentActivity(projectId, hoursBack);
    const project = this.getProject(projectId);

    const commits = recent.filter(a => a.event_type === 'commit');
    const activePeriods = recent.filter(a => a.event_type === 'active_coding');
    const fileSaves = recent.filter(a => a.event_type === 'file_save');

    // Collect unique file paths touched (privacy-safe: relative paths only)
    const filePaths = new Set();
    const allSubjects = [];
    commits.forEach(c => {
      try {
        const meta = JSON.parse(c.metadata || '{}');
        if (Array.isArray(meta.changedFiles)) {
          meta.changedFiles.forEach(f => {
            const parts = f.replace(/\\/g, '/').split('/');
            const relPath = parts.slice(-2).join('/');
            filePaths.add(relPath);
          });
        }
        if (Array.isArray(meta.subjects)) allSubjects.push(...meta.subjects);
      } catch {}
    });

    const totalCommits = commits.reduce((sum, c) => {
      try { return sum + (JSON.parse(c.metadata || '{}').count || 0); }
      catch { return sum; }
    }, 0);

    const activeMinutes = activePeriods.length * 5;

    let summary = '';
    if (totalCommits > 0) {
      summary += `${totalCommits} commit${totalCommits !== 1 ? 's' : ''}`;
      if (filePaths.size > 0) {
        const paths = [...filePaths].slice(0, 3).join(', ');
        summary += `, touching ${paths}`;
      }
    }
    if (activeMinutes > 0) {
      const h = (activeMinutes / 60).toFixed(1);
      summary += summary ? `, ${h}h active` : `${h}h active`;
    }
    if (fileSaves.length > 0 && !summary) {
      summary = `${fileSaves.length} file save${fileSaves.length !== 1 ? 's' : ''}`;
    }

    const goals = this.getActiveGoals(projectId);

    return {
      project: project?.name || 'Unknown',
      totalCommits,
      activeMinutes,
      filePaths: [...filePaths],
      subjects: allSubjects,
      summary: summary || 'No recent activity',
      goals: goals.map(g => g.goal_text),
    };
  }
}

module.exports = DB;
