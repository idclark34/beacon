'use strict';

/**
 * ActivityTracker — uses file modification events as a proxy for coding activity.
 *
 * Every 5 minutes, if there have been file saves in a watched project,
 * we log an 'active_coding' event for that project. This avoids the need
 * for native keyboard/mouse hooks while still giving a reasonable estimate
 * of active coding time.
 */

const WINDOW_MS = 5 * 60 * 1000; // 5-minute windows

class ActivityTracker {
  constructor(database, fileWatcher) {
    this.db = database;
    this.fileWatcher = fileWatcher;
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) return;

    this.intervalId = setInterval(() => {
      this._evaluateWindow();
    }, WINDOW_MS);

    console.log('[ActivityTracker] Started (5-min window polling)');
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  _evaluateWindow() {
    const projects = this.db.getProjects();

    for (const project of projects) {
      if (!this.fileWatcher.watchers.has(project.id)) continue;

      const saveCount = this.fileWatcher.drainSaveCount(project.id);
      if (saveCount > 0) {
        this.db.logActivity(project.id, 'active_coding', {
          fileSavesInWindow: saveCount,
        });
        console.log(
          `[ActivityTracker] Project ${project.id} (${project.name}): active (${saveCount} saves)`
        );
      }
    }
  }

  /**
   * Returns total active minutes for a project since a given Date.
   */
  getActiveMinutesSince(projectId, since) {
    return this.db.getActiveMinutesSince(projectId, since);
  }

  /**
   * Returns true if the project has been active in the last `minutes` minutes.
   */
  isRecentlyActive(projectId, minutes = 30) {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    return this.getActiveMinutesSince(projectId, since) > 0;
  }
}

module.exports = ActivityTracker;
