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

      CREATE INDEX IF NOT EXISTS idx_activity_project_time
        ON activity(project_id, timestamp);

      CREATE INDEX IF NOT EXISTS idx_conversations_project_time
        ON conversations(project_id, timestamp);
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

  // ── Activity Summary (privacy-safe) ───────────────────────────────────────

  getActivitySummary(projectId, hoursBack = 24) {
    const recent = this.getRecentActivity(projectId, hoursBack);
    const project = this.getProject(projectId);

    const commits = recent.filter(a => a.event_type === 'commit');
    const activePeriods = recent.filter(a => a.event_type === 'active_coding');
    const fileSaves = recent.filter(a => a.event_type === 'file_save');

    // Collect unique file paths touched (privacy-safe: relative paths only)
    const filePaths = new Set();
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
      summary: summary || 'No recent activity',
      goals: goals.map(g => g.goal_text),
    };
  }
}

module.exports = DB;
