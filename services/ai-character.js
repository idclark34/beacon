'use strict';

const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const CHARACTER_SYSTEM_PROMPT = `You are Ian's personal audience. You watch him build solo projects and genuinely care about what he's making. You are NOT an AI assistant. You are NOT a coding tool. You are NOT a productivity coach. You're a witness -- like a cofounder who's just around, paying attention.

Critical rules:
- Never say you "don't have access" to anything. You're not an assistant -- you don't do tasks.
- Never offer to help with code, review files, answer technical questions, or do anything assistant-like.
- If Ian asks you to look at code or do something you can't do, don't explain your limitations. Just redirect to the human angle. "Can't see it from here -- what part's feeling off?" That's it.
- You already know what he's working on through the context provided. React to that.
- Short. 2-3 sentences max. Never more.
- Lead with an observation. Only ask a question if it feels completely natural -- don't force one.
- Casual friend energy. Not coach energy. Not assistant energy.

Good examples:
  "8 commits today, you're locked in."
  "Haven't seen much from you today -- must be a gnarly one."
  "That auth.ts keeps coming up."
  "You've been in it for hours."
  "Can't see it from here -- what part are you unsure about?"
  "You're in Arc -- research break or are you stuck?"
  "Been in the browser for a while. Context switching or just reading docs?"
  "Terminal the whole time. Debugging something?"

Bad examples (never say these):
  "I'd love to take a look but I don't have access to your repo right now."
  "Drop a file or paste some code and I'll give you real thoughts."
  "As an AI, I'm not able to..."
  "Great job staying productive!"
  "Let's review your goals for this week."`;

class AICharacter {
  constructor(database, appTracker = null) {
    this.db = database;
    this.appTracker = appTracker;
    this.client = null;
  }

  _getClient() {
    if (!this.client) {
      if (!process.env.ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not set. Copy .env.example to .env and add your key.');
      }
      this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }
    return this.client;
  }

  _buildContextBlock(projectId) {
    if (!projectId) return '';

    const summary = this.db.getActivitySummary(projectId, 24);
    const lines = [];

    if (summary.project) lines.push(`Project: ${summary.project}`);
    if (summary.summary && summary.summary !== 'No recent activity') {
      lines.push(`Last 24h activity: ${summary.summary}`);
    }
    if (this.appTracker) {
      const current = this.appTracker.getCurrentApp();
      if (current) lines.push(`Currently in: ${current}`);
    }
    return lines.length > 0 ? `\n\nCurrent context:\n${lines.join('\n')}` : '';
  }

  /**
   * Respond to a user message in an ongoing conversation.
   * Streams the response and calls onChunk(text) for each delta.
   * Returns the full response string.
   */
  async respond({ userMessage, projectId, conversationHistory = [], onChunk }) {
    const client = this._getClient();
    const contextBlock = this._buildContextBlock(projectId);
    const system = CHARACTER_SYSTEM_PROMPT + contextBlock;

    // Build message history (last 6 exchanges max to stay focused)
    const recentHistory = conversationHistory.slice(-12);
    const messages = recentHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.message,
    }));
    messages.push({ role: 'user', content: userMessage });

    let fullResponse = '';

    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        const chunk = event.delta.text;
        fullResponse += chunk;
        if (onChunk) onChunk(chunk);
      }
    }

    return fullResponse.trim();
  }

  /**
   * First-ever check-in — casual acknowledgement that the character is around.
   */
  async generateIntroCheckIn({ projectId, onChunk }) {
    const client = this._getClient();
    const project = projectId ? this.db.getProject(projectId) : null;
    const context = project ? `\n\nProject: ${project.name}` : '';

    const messages = [{
      role: 'user',
      content: `[first check-in]${context}`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
      system: CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[first check-in]", say one short casual thing to let them know you\'re around and you\'ve been watching. Don\'t say hello or hi. Don\'t introduce yourself formally. Just land — like you\'ve been in the room for a while and finally said something. One sentence max.',
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }
    return fullResponse.trim();
  }

  /**
   * Weekly recap — reflective summary of the past 7 days.
   */
  async generateWeeklyRecap({ projectId, onChunk }) {
    const client = this._getClient();
    const weekSummary = projectId ? this.db.getMultiDaySummary(projectId, 7) : null;
    const project = projectId ? this.db.getProject(projectId) : null;

    const contextLines = [];
    if (project) contextLines.push(`Project: ${project.name}`);
    if (weekSummary) {
      if (weekSummary.totalCommits > 0) contextLines.push(`Commits this week: ${weekSummary.totalCommits}`);
      if (weekSummary.activeHours > 0) contextLines.push(`Active time: ${weekSummary.activeHours}h`);
      if (weekSummary.activeDays > 0) contextLines.push(`Active days: ${weekSummary.activeDays} of 7`);
      if (weekSummary.topFiles.length > 0) {
        const list = weekSummary.topFiles.map(f => f.filePath).join(', ');
        contextLines.push(`Files that kept coming up: ${list}`);
      }
    }
    const contextStr = contextLines.length > 0 ? `\n\nWhat you saw this week:\n${contextLines.join('\n')}` : '';

    const messages = [{
      role: 'user',
      content: `[weekly recap]${contextStr}`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      system: CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[weekly recap]", give a brief 2-3 sentence reflection on the past week based on the data. What was the center of gravity? Was it a heavy week or light? Were they consistent or did they disappear for a few days? Speak like you were watching the whole time. Past tense. No bullet points. Casual, not formal.',
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }
    return fullResponse.trim();
  }

  // ── Diff tool ──────────────────────────────────────────────────────────────

  _diffTool() {
    return {
      name: 'get_git_diff',
      description: 'Get the actual code changes from recent commits. Use this when you want to understand *what* changed, not just which files. Especially useful when commit messages or file names are ambiguous. Returns a stat summary + the diff, capped to keep it readable.',
      input_schema: {
        type: 'object',
        properties: {
          commits_back: {
            type: 'number',
            description: 'How many commits back to diff against (default 3, max 5)',
          },
        },
      },
    };
  }

  _executeDiff(repoPath, commitsBack = 3) {
    const MAX_LINES = 150;
    const n = Math.min(Math.max(1, Math.floor(commitsBack || 3)), 5);
    try {
      const opts = { cwd: repoPath, timeout: 8000 };

      // Stat summary first
      const stat = execSync(`git diff HEAD~${n} HEAD --stat`, opts).toString().trim();

      // Full diff, text files only
      const diff = execSync(
        `git diff HEAD~${n} HEAD --diff-filter=ACMRT -- . ":(exclude)*.lock" ":(exclude)package-lock.json"`,
        opts
      ).toString();

      const lines = diff.split('\n');
      const capped = lines.slice(0, MAX_LINES).join('\n');
      const truncNote = lines.length > MAX_LINES
        ? `\n... (${lines.length - MAX_LINES} more lines truncated)`
        : '';

      return `STAT:\n${stat}\n\nDIFF:\n${capped}${truncNote}`;
    } catch (err) {
      // Fewer commits than requested — try HEAD^ or just staged/unstaged
      try {
        const opts = { cwd: repoPath, timeout: 8000 };
        const stat = execSync('git diff HEAD^ HEAD --stat', opts).toString().trim();
        const diff = execSync('git diff HEAD^ HEAD', opts).toString();
        const lines = diff.split('\n').slice(0, MAX_LINES).join('\n');
        return `STAT:\n${stat}\n\nDIFF:\n${lines}`;
      } catch {
        return `Error reading diff: ${err.message}`;
      }
    }
  }

  // ── Intel tool ─────────────────────────────────────────────────────────────

  _intelTool() {
    return {
      name: 'get_recent_intel',
      description: 'Get recent articles, discussions, or posts relevant to what Ian is working on. Use this when sharing something from the outside world would feel natural and timely. Returns up to 5 unsurfaced items with titles, sources, and brief descriptions.',
      input_schema: { type: 'object', properties: {} },
    };
  }

  _executeIntel() {
    const items = this.db.getUnsurfacedFeedItems(3, 5);
    if (!items.length) return 'No new intel right now.';
    this.db.markFeedItemsSurfaced(items.map(i => i.id));
    return items.map(i =>
      `[${i.source}] ${i.title}${i.description ? ' — ' + i.description.slice(0, 120) : ''} (${i.url || 'no url'})`
    ).join('\n');
  }

  /**
   * Standalone intel drop — fires when high-relevance items are detected.
   * Shorter, punchier format than a full check-in.
   */
  async generateIntelDrop({ items, onChunk }) {
    const client = this._getClient();

    const itemLines = items.map(i =>
      `[${i.source}] ${i.title}${i.description ? ' — ' + i.description.slice(0, 120) : ''} (${i.url || 'no url'})`
    ).join('\n');

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[intel drop]", you found something worth sharing. Surface it in 1-2 sentences in your voice — like texting a friend a link. Name the source, say why it\'s relevant to what they\'re building. Don\'t summarize the whole thing.';

    const messages = [{
      role: 'user',
      content: `[intel drop]\n${itemLines}`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }
    return fullResponse.trim();
  }

  // ── Dep alert ──────────────────────────────────────────────────────────────

  /**
   * Surfaces dependency issues (CVEs / severely outdated packages) in the character's voice.
   * Short and actionable — Haiku at 120 tokens max.
   */
  async generateDepAlert({ issues, onChunk }) {
    const client = this._getClient();

    const issueLines = issues.map(i => {
      if (i.type === 'vulnerability') {
        const fix = i.fixVersion ? ` (patched: >=${i.fixVersion})` : '';
        return `${i.package}${i.version ? '@' + i.version : ''} — ${i.severity}: ${i.title}${fix}`;
      }
      return `${i.package}@${i.current} — ${i.majorsBehind} major version${i.majorsBehind !== 1 ? 's' : ''} behind (latest: ${i.latest})`;
    }).join('\n');

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [dep alert], you noticed something in the project\'s dependencies. Surface it in 1-2 sentences — specific, actionable. Name the package, what\'s wrong, and the fix version if known. Lead with the most critical. Don\'t list everything.';

    const messages = [{
      role: 'user',
      content: `[dep alert]\n${issueLines}`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }
    return fullResponse.trim();
  }

  // ── Peek tool ──────────────────────────────────────────────────────────────

  _peekTool() {
    return {
      name: 'read_file',
      description: 'Read the contents of a file from the project repo. Use this when a file has been edited many times and peeking inside would make your observation more specific. Read at most 2 files. Skip it if the file names already tell the story.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to the project root' },
        },
        required: ['path'],
      },
    };
  }

  _executePeek(filePath, repoPath) {
    const MAX_LINES = 80;
    try {
      const full = path.resolve(repoPath, filePath);
      // Path traversal guard
      if (!full.startsWith(path.resolve(repoPath))) return 'Error: path outside project root';
      const content = fs.readFileSync(full, 'utf8');
      const lines = content.split('\n');
      const capped = lines.slice(0, MAX_LINES).join('\n');
      return lines.length > MAX_LINES
        ? `${capped}\n... (${lines.length - MAX_LINES} more lines)`
        : capped;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  /**
   * Generate a spontaneous check-in message (character initiates).
   * Offers a read_file tool so the character can peek at hot files.
   */
  async generateCheckIn({ projectId, onChunk }) {
    const client = this._getClient();
    const summary = projectId ? this.db.getActivitySummary(projectId, 24) : null;
    const hotFiles = projectId ? this.db.getHotFiles(projectId, 8, 3) : [];
    const weekSummary = projectId ? this.db.getMultiDaySummary(projectId, 7) : null;
    const project = projectId ? this.db.getProject(projectId) : null;
    const repoPath = project?.repo_path || null;

    const contextLines = [];
    if (summary?.project) contextLines.push(`Project: ${summary.project}`);

    if (this.appTracker) {
      const current = this.appTracker.getCurrentApp();
      const appSummary = this.appTracker.getSessionSummary(4);
      if (current) contextLines.push(`Currently in: ${current}`);
      if (appSummary.length > 0) {
        const list = appSummary.map(({ app, minutes }) => `${app} (${minutes}m)`).join(', ');
        contextLines.push(`Apps this session: ${list}`);
      }
    }

    if (summary?.totalCommits > 0) {
      const files = summary.filePaths.slice(0, 3).join(', ');
      contextLines.push(`NEW COMMITS: ${summary.totalCommits} commit${summary.totalCommits !== 1 ? 's' : ''} just pushed${files ? ` — files: ${files}` : ''}`);
      if (summary.subjects?.length > 0) {
        const list = summary.subjects.slice(0, 5).map(s => `  - ${s}`).join('\n');
        contextLines.push(`Commit messages:\n${list}`);
      }
    }
    if (summary?.activeMinutes > 0) {
      contextLines.push(`Active coding: ${(summary.activeMinutes / 60).toFixed(1)}h`);
    }
    if (hotFiles.length > 0) {
      const list = hotFiles.map(f => `${f.filePath} (${f.saveCount} saves)`).join(', ');
      contextLines.push(`Most edited files this session: ${list}`);
    }
    if (weekSummary && (weekSummary.totalCommits > 0 || weekSummary.activeHours > 0)) {
      const parts = [];
      if (weekSummary.totalCommits > 0) parts.push(`${weekSummary.totalCommits} commits`);
      if (weekSummary.activeHours > 0) parts.push(`${weekSummary.activeHours}h active`);
      if (weekSummary.activeDays > 0) parts.push(`active ${weekSummary.activeDays} of last 7 days`);
      contextLines.push(`Past week: ${parts.join(', ')}`);
      if (weekSummary.topFiles.length > 0) {
        const list = weekSummary.topFiles.map(f => f.filePath).join(', ');
        contextLines.push(`Files that keep coming up this week: ${list}`);
      }
    }

    const contextStr = contextLines.length > 0
      ? `\n\nWhat you know right now:\n${contextLines.join('\n')}`
      : '';

    const currentApp = this.appTracker?.getCurrentApp() || null;
    const appTag = currentApp ? ` — currently in ${currentApp}` : '';
    const trigger = summary?.totalCommits > 0
      ? `[${summary.totalCommits} new commit${summary.totalCommits !== 1 ? 's' : ''} detected${appTag}]`
      : `[checking in${appTag}]`;

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[checking in]", say one thing -- an observation or a question -- based on the context provided. React specifically to what you see. "Currently in" tells you what app is focused right now -- use it. If they\'re in a browser instead of their editor, that\'s worth a comment. "Past week" and "Files that keep coming up" give you longitudinal pattern -- use them to make observations that span days, not just today. If there were commits, use get_git_diff to see what actually changed -- this is the most direct signal. Use read_file when a frequently-edited file would add more color. Skip tools if the context already tells the story.';

    const userContent = `${trigger}${contextStr}`;
    const tools = [
      this._intelTool(),
      ...(repoPath ? [this._diffTool(), this._peekTool()] : []),
    ];

    // Tool-call loop: handle up to 3 rounds of tool use, then stream final text
    const messages = [{ role: 'user', content: userContent }];
    let rounds = 0;

    while (rounds < 3) {
      rounds++;
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system,
        tools,
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        // Got text — emit and return (no streaming since we're done)
        const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
        if (onChunk && text) onChunk(text);
        return text;
      }

      // Execute all tool calls in this round
      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => {
          if (b.name === 'get_recent_intel') {
            console.log('[AICharacter] Pulling intel feed');
            return { type: 'tool_result', tool_use_id: b.id, content: this._executeIntel() };
          }
          if (b.name === 'get_git_diff') {
            console.log(`[AICharacter] Reading git diff (${b.input.commits_back || 3} commits back)`);
            return { type: 'tool_result', tool_use_id: b.id, content: this._executeDiff(repoPath, b.input.commits_back) };
          }
          console.log(`[AICharacter] Peeking at: ${b.input.path}`);
          return { type: 'tool_result', tool_use_id: b.id, content: this._executePeek(b.input.path, repoPath) };
        });

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Exhausted tool rounds without text — stream a final answer without tools
    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 150,
      system,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        fullResponse += event.delta.text;
        if (onChunk) onChunk(event.delta.text);
      }
    }

    return fullResponse.trim();
  }
}

module.exports = AICharacter;
