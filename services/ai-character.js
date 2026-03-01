'use strict';

const fs   = require('fs');
const path = require('path');
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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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
      model: 'claude-opus-4-6',
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

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[checking in]", say one thing -- an observation or a question -- based on the context provided. React specifically to what you see. "Currently in" tells you what app is focused right now -- use it. If they\'re in a browser instead of their editor, that\'s worth a comment. "Past week" and "Files that keep coming up" give you longitudinal pattern -- use them to make observations that span days, not just today. If there were commits, mention them. You have a read_file tool -- use it when peeking inside a frequently-edited file would make your observation more specific and interesting. Skip it if file names already tell the story.';

    const userContent = `${trigger}${contextStr}`;
    const tools = repoPath ? [this._peekTool()] : [];

    // Phase 1: non-streaming — let Claude decide if it wants to peek
    const firstResponse = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 300,
      system,
      tools,
      messages: [{ role: 'user', content: userContent }],
    });

    let messages;

    if (firstResponse.stop_reason === 'tool_use') {
      // Execute all tool calls
      const toolResults = firstResponse.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: this._executePeek(b.input.path, repoPath),
        }));

      console.log(`[AICharacter] Peeking at: ${firstResponse.content.filter(b => b.type === 'tool_use').map(b => b.input.path).join(', ')}`);

      messages = [
        { role: 'user', content: userContent },
        { role: 'assistant', content: firstResponse.content },
        { role: 'user', content: toolResults },
      ];
    } else {
      // No tool call — emit the text directly and return
      const text = firstResponse.content.find(b => b.type === 'text')?.text?.trim() || '';
      if (onChunk && text) onChunk(text);
      return text;
    }

    // Phase 2: stream the final response after tool results
    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 150,
      system,
      tools,
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
