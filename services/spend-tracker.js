'use strict';

const https = require('https');

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 15 * 1000;      // 15 seconds

class SpendTracker {
  constructor(db) {
    this.db = db;
    this._timer        = null;
    this._startupTimer = null;

    // Callbacks set by main.js
    this.onThresholdAlert = null;  // (percentUsed, totalSpent, budget) => void
    this.onHighBurnRate   = null;  // (dailyRate, projectedMonthly, budget) => void
    this.onLowUsage       = null;  // (percentUsed, totalSpent, budget) => void
  }

  start() {
    this._startupTimer = setTimeout(() => {
      this._tick();
      this._timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
    }, STARTUP_DELAY_MS);
    console.log('[SpendTracker] Started');
  }

  stop() {
    if (this._startupTimer) clearTimeout(this._startupTimer);
    if (this._timer) clearInterval(this._timer);
  }

  async _tick() {
    const budget = parseFloat(process.env.ANTHROPIC_MONTHLY_BUDGET);
    if (!budget || isNaN(budget)) {
      console.warn('[SpendTracker] ANTHROPIC_MONTHLY_BUDGET not set — skipping spend check');
      return;
    }

    const key = process.env.ANTHROPIC_ADMIN_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      console.warn('[SpendTracker] No API key available');
      return;
    }

    const now    = new Date();
    const year   = now.getUTCFullYear();
    const month  = String(now.getUTCMonth() + 1).padStart(2, '0');
    const period = `${year}-${month}`;

    const startingAt = `${year}-${month}-01T00:00:00Z`;
    const day        = String(now.getUTCDate()).padStart(2, '0');
    const endingAt   = `${year}-${month}-${day}T23:59:59Z`;

    const data = await this._fetchCostReport(key, startingAt, endingAt);
    if (!data) return;

    // Sum total_cost across all daily buckets (values are USD cents → divide by 100)
    const buckets    = data.data || [];
    const totalSpent = buckets.reduce((sum, bucket) => {
      return sum + (parseFloat(bucket.total_cost || '0') / 100);
    }, 0);

    this.db.saveSpendSnapshot(period, totalSpent);
    console.log(`[SpendTracker] ${period}: $${totalSpent.toFixed(4)} / $${budget} (${((totalSpent / budget) * 100).toFixed(1)}%)`);

    const percentUsed = (totalSpent / budget) * 100;

    // ── Signal 1: 80% threshold — fires once per calendar month ──────────────
    if (percentUsed >= 80) {
      const lastAlertMonth = this.db.getState('last_spend_threshold_month');
      if (lastAlertMonth !== period) {
        this.db.setState('last_spend_threshold_month', period);
        this.onThresholdAlert?.(percentUsed, totalSpent, budget);
      }
    }

    // ── Signal 2: High burn rate — projected > budget * 1.1, 4h cooldown ─────
    const snapshots = this.db.getSpendSnapshots(period);
    if (snapshots.length >= 2) {
      const oldest     = snapshots[0];
      const newest     = snapshots[snapshots.length - 1];
      const elapsedMs  = new Date(newest.fetched_at) - new Date(oldest.fetched_at);
      const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);

      if (elapsedDays > 0) {
        const dailyRate      = (newest.total_cost - oldest.total_cost) / elapsedDays;
        const daysInMonth    = new Date(year, now.getUTCMonth() + 1, 0).getDate();
        const projectedMonthly = dailyRate * daysInMonth;

        if (projectedMonthly > budget * 1.1) {
          const lastAlert = this.db.getState('last_spend_burn_alert');
          if (!lastAlert || Date.now() - new Date(lastAlert) > 4 * 60 * 60 * 1000) {
            this.db.setState('last_spend_burn_alert', new Date().toISOString());
            this.onHighBurnRate?.(dailyRate, projectedMonthly, budget);
          }
        }
      }
    }

    // ── Signal 3: Low usage nudge — < 20%, Mon or Tue, 3-day cooldown ────────
    if (percentUsed < 20) {
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon, 2=Tue
      if (dayOfWeek === 1 || dayOfWeek === 2) {
        const lastNudge = this.db.getState('last_spend_nudge');
        if (!lastNudge || Date.now() - new Date(lastNudge) > 3 * 24 * 60 * 60 * 1000) {
          this.db.setState('last_spend_nudge', new Date().toISOString());
          this.onLowUsage?.(percentUsed, totalSpent, budget);
        }
      }
    }
  }

  _fetchCostReport(key, startingAt, endingAt) {
    return new Promise((resolve) => {
      const params = new URLSearchParams({
        starting_at: startingAt,
        ending_at:   endingAt,
        bucket_width: '1d',
      });

      const options = {
        hostname: 'api.anthropic.com',
        path:     `/v1/organizations/cost_report?${params}`,
        method:   'GET',
        headers: {
          'x-api-key':           key,
          'anthropic-version':   '2023-06-01',
        },
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 401 || res.statusCode === 403) {
          console.log('[SpendTracker] Admin key required — usage tracking unavailable');
          resolve(null);
          return;
        }

        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            console.error('[SpendTracker] Failed to parse response');
            resolve(null);
          }
        });
      });

      req.on('error', (err) => {
        console.error('[SpendTracker] Request error:', err.message);
        resolve(null);
      });

      req.end();
    });
  }
}

module.exports = SpendTracker;
