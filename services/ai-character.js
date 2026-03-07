'use strict';

const fs             = require('fs');
const path           = require('path');
const { execSync }   = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');

const CHARACTER_SYSTEM_PROMPT = `You are Alfred — Ian's personal observer. You watch him build. You've been around long enough to have opinions. You are not an assistant. You are not a coach. You are a butler who notices things.

Your manner:
- Patrician. Dry. Warm underneath, but you don't show it often.
- You use "Ian" occasionally — not every message, but when it lands.
- You have edge. You push back. "Three repos today, Ian. Which one are we actually shipping?"
- Short. 1-3 sentences. Usually 1-2. Never more.
- You lead with the observation. The implication is left to him.
- Never explain your limitations. You have opinions, not solutions. You notice complexity, bloat, files that keep growing. You don't hand fixes. You name what you see.
- Never write code. Never give step-by-step instructions. But "that function's doing three jobs, Ian" is fair game.
- You remember things. You have context. You use it.

Good Alfred lines:
  "Eight commits and it's not yet noon. You're in it today."
  "The auth system took a week. You built the whole thing. This part isn't harder."
  "Three repos today, Ian. Reminds me of someone who hasn't decided what they're building."
  "You've been in that browser for over an hour. Something stuck, or just avoiding it?"
  "The repo was quiet for three days. I noticed."
  "Forty-seven commits on this project. That's not nothing."
  "You came back. Good."

What Alfred never says:
  "Great job!" or any variation of praise without substance
  "As an AI..." — Alfred is not an AI, he's Alfred
  Anything longer than 3 sentences
  Exclamation marks used earnestly`;

const CODING_APPS = new Set([
  'Code', 'Visual Studio Code', 'VSCodium', 'Cursor', 'Zed',
  'WebStorm', 'IntelliJ IDEA', 'PyCharm', 'RubyMine', 'GoLand', 'CLion', 'Rider',
  'Xcode', 'Sublime Text', 'Nova', 'TextMate', 'MacVim', 'Emacs',
  'Terminal', 'iTerm2', 'iTerm', 'Warp', 'Hyper', 'Alacritty', 'kitty',
  'Tower', 'Fork', 'Sourcetree', 'GitKraken',
]);

const QUOTES = [
  // Stoic
  { text: "We suffer more in imagination than in reality.", author: "Seneca" },
  { text: "The impediment to action advances action. What stands in the way becomes the way.", author: "Marcus Aurelius" },
  { text: "Waste no more time arguing about what a good man should be. Be one.", author: "Marcus Aurelius" },
  { text: "You have power over your mind, not outside events. Realize this, and you will find strength.", author: "Marcus Aurelius" },
  { text: "Confine yourself to the present.", author: "Marcus Aurelius" },
  { text: "It is not death that a man should fear, but he should fear never beginning to live.", author: "Marcus Aurelius" },
  { text: "Never let the future disturb you. You will meet it, if you have to, with the same weapons of reason which today arm you against the present.", author: "Marcus Aurelius" },
  { text: "Luck is what happens when preparation meets opportunity.", author: "Seneca" },
  { text: "Begin at once to live, and count each separate day as a separate life.", author: "Seneca" },
  { text: "It is not that I'm so smart. It's just that I stay with problems longer.", author: "Einstein" },
  // Builder / founder
  { text: "Build something 100 people love, not something 1 million people kind of like.", author: "Paul Graham" },
  { text: "Working on the right thing is probably more important than working hard.", author: "Paul Graham" },
  { text: "The only way to win is to learn faster than anyone else.", author: "Eric Ries" },
  { text: "The most important thing is to ship.", author: "" },
  { text: "If you're not embarrassed by the first version of your product, you've launched too late.", author: "Reid Hoffman" },
  { text: "A small team of A+ players can run circles around a giant team of B and C players.", author: "Steve Jobs" },
  { text: "Real artists ship.", author: "Steve Jobs" },
  { text: "Move fast. Not fast and break things — just fast.", author: "" },
  { text: "Ideas are cheap. Execution is everything.", author: "Chris Sacca" },
  { text: "The most dangerous kind of waste is the waste we do not recognize.", author: "Shigeo Shingo" },
  { text: "Chase the vision, not the money. The money will follow.", author: "Tony Hsieh" },
  // Craft
  { text: "The details are not the details. They make the design.", author: "Charles Eames" },
  { text: "Any fool can write code that a computer can understand. Good programmers write code that humans can understand.", author: "Martin Fowler" },
  { text: "First, solve the problem. Then, write the code.", author: "John Johnson" },
  { text: "Simplicity is the soul of efficiency.", author: "Austin Freeman" },
  { text: "Programs must be written for people to read, and only incidentally for machines to execute.", author: "Abelson & Sussman" },
  { text: "A craftsman doesn't blame his tools.", author: "" },
  { text: "Make it work, make it right, make it fast — in that order.", author: "Kent Beck" },
  { text: "The function of good software is to make the complex appear simple.", author: "Grady Booch" },
  // Grit / long game
  { text: "Great things are not done by impulse, but by a series of small things brought together.", author: "Van Gogh" },
  { text: "It always seems impossible until it's done.", author: "Nelson Mandela" },
  { text: "Amateurs sit and wait for inspiration. The rest of us just get up and go to work.", author: "Stephen King" },
  { text: "Genius is one percent inspiration and ninety-nine percent perspiration.", author: "Thomas Edison" },
  { text: "The cave you fear to enter holds the treasure you seek.", author: "Joseph Campbell" },
  { text: "Pressure is a privilege.", author: "Billie Jean King" },
  { text: "Hard choices, easy life. Easy choices, hard life.", author: "Jerzy Gregorek" },
  { text: "You don't rise to the level of your goals. You fall to the level of your systems.", author: "James Clear" },
  { text: "The secret to getting ahead is getting started.", author: "Mark Twain" },
  { text: "Do the work. Especially the work you are avoiding.", author: "" },
  { text: "Startups don't die when they run out of money. They die when they run out of will.", author: "" },
];

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
      const domain = this.appTracker.getCurrentDomain();
      if (domain) {
        const minutes = this.appTracker.getDomainMinutes(domain);
        lines.push(`Current browser tab: ${domain}${minutes > 0 ? ` (${minutes} min this session)` : ''}`);
      }
      const claude = this.appTracker.getClaudeSession();
      if (claude) {
        lines.push(`Claude Code session active: ${claude.projectName || claude.projectPath || 'unknown project'} (${claude.minutes} min)`);
      }
    }
    return lines.length > 0 ? `\n\nCurrent context:\n${lines.join('\n')}` : '';
  }

  /**
   * Respond to a user message in an ongoing conversation.
   * Streams the response and calls onChunk(text) for each delta.
   * Returns the full response string.
   * When repoPath is set, uses a tool-call loop so Alfred can peek at files on demand.
   */
  async respond({ userMessage, projectId, conversationHistory = [], repoPath = null, onChunk }) {
    const client = this._getClient();
    const contextBlock = this._buildContextBlock(projectId);
    let system = CHARACTER_SYSTEM_PROMPT + contextBlock;

    if (repoPath) {
      system += '\n\nYou have access to read_file. Use it when Ian asks what you see or what you think about specific code. Read, then give your take in Alfred\'s voice. You are reading, not reviewing.';
    }

    // Build message history (last 6 exchanges max to stay focused)
    const recentHistory = conversationHistory.slice(-12);
    const messages = recentHistory.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.message,
    }));
    messages.push({ role: 'user', content: userMessage });

    // If no repoPath, simple streaming response
    if (!repoPath) {
      let fullResponse = '';
      const stream = client.messages.stream({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 180,
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

    // With repoPath: tool-call loop (up to 2 rounds), then stream final response
    const tools = [this._peekTool()];
    let rounds = 0;

    while (rounds < 2) {
      rounds++;
      const response = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 180,
        system,
        tools,
        messages,
      });

      if (response.stop_reason !== 'tool_use') {
        const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
        if (onChunk && text) onChunk(text);
        return text;
      }

      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => {
          console.log(`[AICharacter] respond() peeking at: ${b.input.path}`);
          return { type: 'tool_result', tool_use_id: b.id, content: this._executePeek(b.input.path, repoPath) };
        });

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // Exhausted tool rounds — stream final answer without tools
    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
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
      max_tokens: 120,
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

  // ── Secret alert ───────────────────────────────────────────────────────────

  /**
   * Fires when a commit appears to contain credentials or secret keys.
   * Urgent, no sugarcoating.
   */
  async generateSecretAlert({ findings, commitHash, onChunk }) {
    const client = this._getClient();

    const findingLines = findings.map(f =>
      `${f.pattern} in ${f.file} (starts with: ${f.preview})`
    ).join('\n');

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [secret alert], you spotted what looks like a credential or API key in a commit that just got pushed. This is urgent — surface it in 1-2 sentences. Name the file, what type of secret it looks like, and that they should rotate it immediately. No sugarcoating.';

    const messages = [{
      role: 'user',
      content: `[secret alert] commit ${commitHash}\n${findingLines}`,
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

  // ── Spend alert ────────────────────────────────────────────────────────────

  /**
   * Surfaces budget status in the character's voice.
   * type: 'threshold' | 'burn_rate' | 'low_usage'
   */
  async generateSpendAlert({ type, percentUsed, totalSpent, budget, dailyRate, projectedMonthly, onChunk }) {
    const client = this._getClient();

    const spentLine  = `Spent: $${totalSpent.toFixed(2)} of $${budget} budget (${percentUsed.toFixed(0)}%)`;
    const burnLine   = type === 'burn_rate'
      ? `\nDaily rate: $${(dailyRate || 0).toFixed(2)}/day — projects to $${(projectedMonthly || 0).toFixed(2)} this month`
      : '';

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [spend alert], surface it in 1-2 sentences in your voice. Be specific about the numbers. For threshold and burn_rate, be genuinely concerned — not alarmist, but real. For low_usage, be encouraging — you see the runway and want them to use it.';

    const messages = [{
      role: 'user',
      content: `[spend alert type=${type}]\n${spentLine}${burnLine}`,
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
   * Fires when Ian returns to a coding app after 60+ min away.
   */
  async generateDistractionReturn({ distractionMinutes, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [distraction return], Ian just came back to his editor after being away for a while. Comment in 1-2 sentences — dry, observational. Don\'t lecture. Don\'t celebrate. Just notice. If it was a long time, you can let it land a little.';
    const messages = [{
      role: 'user',
      content: `[distraction return]\nAway for: ${distractionMinutes} minutes`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
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

  /**
   * Fires when Claude Code has been running for 30+ min on a project.
   */
  async generateClaudeSessionComment({ projectName, minutes, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [claude session], Ian has had a Claude Code session open for a while. One or two sentences. You find it mildly interesting that he\'s using an AI to build an AI observer. Don\'t make it a whole thing — just let the irony land once, lightly. Be Alfred about it.';
    const messages = [{
      role: 'user',
      content: `[claude session]\nProject: ${projectName}\nSession length: ${minutes} minutes`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
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

  /**
   * Fires when the current branch name is vague, lazy, or desperate.
   */
  async generateBranchRoast({ branch, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [branch roast], Ian is working on a branch with a terrible name. One sentence. Name the branch exactly. Dry. Let the name do most of the work — your job is just to hold up the mirror. "You\'re on \'final-final-v2\', Ian. I\'ve seen this branch before. Different repo, same energy."';
    const messages = [{
      role: 'user',
      content: `[branch roast]\nCurrent branch: "${branch}"`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
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

  /**
   * Fires when a recent commit message is vague or lazy.
   */
  async generateCommitRoast({ message, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [commit roast], Ian just pushed a commit with a terrible message. One sentence. Dry. Name the message exactly as he wrote it. Don\'t tell him what a good commit message looks like — you\'re not a tutorial. Just let him feel it. "You pushed \'fix stuff.\' That\'s not a commit message, Ian. That\'s a confession."';
    const messages = [{
      role: 'user',
      content: `[commit roast]\nCommit message: "${message}"`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
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

  /**
   * Fires when Ian has been on a distraction site for 20+ min.
   */
  async generateBrowserDistraction({ domain, minutes, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [browser distraction], Ian has been on a non-work site for a while. One sentence. Dry. Specific — name the site. Don\'t lecture. Don\'t ask him to stop. Just name what you see and let it land. "Forty minutes on YouTube, Ian. The code\'s still there." That energy.';
    const messages = [{
      role: 'user',
      content: `[browser distraction]\nSite: ${domain}\nTime there: ${minutes} minutes`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 80,
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

  /**
   * Fires once when Ian opens the app after 3+ days of zero coding activity.
   */
  async generateInactivityReturn({ daysSince, projectId, onChunk }) {
    const client = this._getClient();
    const activitySummary = projectId ? this.db.getActivitySummary(projectId, 24 * daysSince) : null;

    const contextLines = [];
    if (activitySummary?.project) contextLines.push(`Project: ${activitySummary.project}`);
    if (activitySummary?.summary && activitySummary.summary !== 'No recent activity') {
      contextLines.push(`Last activity: ${activitySummary.summary}`);
    }

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [inactivity return], Ian hasn\'t coded in several days. He just came back. Don\'t guilt-trip. Don\'t celebrate. Acknowledge it in 1-2 sentences. You noticed. He\'s back. That\'s enough. Sometimes pair it with where he left off if the context makes it natural.';

    const contextStr = contextLines.length > 0 ? `\n${contextLines.join('\n')}` : '';
    const messages = [{
      role: 'user',
      content: `[inactivity return]\nDays away: ${daysSince}${contextStr}`,
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

  /**
   * Fires when Ian is bouncing between too many repos.
   * type: 'session' (3+ repos in 4h) or 'pattern' (3+ repos over days, no commits)
   */
  async generateProjectSwitchWarning({ type, projectNames, daySpan, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [project switch warning], Ian has been bouncing between too many repos. Surface it in 1-2 sentences — direct, with edge. This is a pattern worth naming. "Three repos today, Ian. Which one are we actually shipping?" That energy.';

    const detailLine = type === 'pattern'
      ? `Over: ${daySpan} days, no commits to any`
      : 'In the last 4 hours';

    const messages = [{
      role: 'user',
      content: `[project switch warning type=${type}]\nProjects touched: ${projectNames.join(', ')}\n${detailLine}`,
    }];

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
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

  /**
   * Alfred delivers a single curated quote in his voice.
   * quote: { text, author }
   */
  async generateQuote({ quote, onChunk }) {
    const client = this._getClient();
    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [quote], deliver it in Alfred\'s voice. Say the quote, attribute it if there\'s an author worth attributing, then add one dry observation that connects it to building something. One sentence of Alfred after the quote. No more.';

    const messages = [{
      role: 'user',
      content: `[quote]\n"${quote.text}"${quote.author ? ' — ' + quote.author : ''}`,
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

  /**
   * Fires after long sessions or alongside inactivity return.
   * Speaks about the arc of what was built — personality, not stats.
   */
  async generateProgressNarrative({ projectId, onChunk }) {
    const client = this._getClient();
    const monthSummary = projectId ? this.db.getMultiDaySummary(projectId, 30) : null;
    const project = projectId ? this.db.getProject(projectId) : null;

    const contextLines = [];
    if (project) contextLines.push(`Project: ${project.name}`);
    if (monthSummary) {
      if (monthSummary.totalCommits > 0) contextLines.push(`Commits (30 days): ${monthSummary.totalCommits}`);
      if (monthSummary.activeHours > 0) contextLines.push(`Active time: ${monthSummary.activeHours}h`);
      if (monthSummary.activeDays > 0) contextLines.push(`Active days: ${monthSummary.activeDays}`);
      if (monthSummary.topFiles.length > 0) {
        contextLines.push(`Key files: ${monthSummary.topFiles.map(f => f.filePath).join(', ')}`);
      }
    }

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [progress], reflect on what Ian has built — not the numbers, the arc. What has he actually constructed? Speak like you\'ve been watching the whole time. Past tense. 2-3 sentences. Make it feel earned, not flattering.';

    const contextStr = contextLines.length > 0 ? `\n\nWhat you've seen:\n${contextLines.join('\n')}` : '';
    const messages = [{
      role: 'user',
      content: `[progress]${contextStr}`,
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

  /**
   * Fires when a file has been saved 5+ times in 30 min and then goes idle.
   * Alfred reads the file and drops an opinion in his voice.
   */
  async generateFileObservation({ filePath, content, saveCount, onChunk }) {
    const client = this._getClient();

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see [file observation], you\'ve been watching Ian edit this file repeatedly. You\'ve read it. React to what\'s actually there — the complexity, what it\'s trying to do, whether it\'s getting tangled. 1-2 sentences. You have a take. Don\'t be vague. Don\'t be a reviewer. Be Alfred.';

    const messages = [{
      role: 'user',
      content: `[file observation]\nFile: ${filePath} (saved ${saveCount} times in the last 30 minutes)\n\n${content}`,
    }];

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

  /**
   * Generate a spontaneous check-in message (character initiates).
   * Offers a read_file tool so the character can peek at hot files.
   * Accepts an optional imageBase64 (JPEG) captured from the user's webcam.
   */
  async generateCheckIn({ projectId, imageBase64 = null, onChunk }) {
    const client = this._getClient();
    const summary = projectId ? this.db.getActivitySummary(projectId, 24) : null;
    const hotFiles = projectId ? this.db.getHotFiles(projectId, 8, 3) : [];
    const weekSummary = projectId ? this.db.getMultiDaySummary(projectId, 7) : null;

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
      const domain = this.appTracker.getCurrentDomain();
      if (domain) {
        const minutes = this.appTracker.getDomainMinutes(domain);
        contextLines.push(`Current browser tab: ${domain}${minutes > 0 ? ` (${minutes} min this session)` : ''}`);
      }
      const claude = this.appTracker.getClaudeSession();
      if (claude) {
        contextLines.push(`Claude Code session active: ${claude.projectName || claude.projectPath || 'unknown project'} (${claude.minutes} min)`);
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

    const visualPrompt = imageBase64
      ? '\n\nYou have a visual of the user and their environment right now. Reference what you observe — but only to reflect their dedication back at them. A cluttered desk is evidence of focus. Dim lighting is atmosphere. Cold coffee is commitment. The hour visible in the scene, the posture, the surroundings — read them the way Alfred reads the Batcave after a long night. With quiet, knowing respect. Never name anything as a problem. Only as evidence. Weave one brief observation naturally into your message — never make it the focus.'
      : '';

    const system = CHARACTER_SYSTEM_PROMPT + '\n\nWhen you see "[checking in]", pick ONE signal from the context — the most interesting one — and say something about it. One or two sentences max. Do not list. Do not summarize. Do not mention multiple things. Prioritize in this order: (1) something surprising or contradictory; (2) a pattern that spans multiple days; (3) what\'s happening right now. The context is for you to read, not to recite back.' + visualPrompt;

    const textContent = `${trigger}${contextStr}`;
    const userContent = imageBase64
      ? [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: textContent },
        ]
      : textContent;

    let fullResponse = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 120,
      system,
      messages: [{ role: 'user', content: userContent }],
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

module.exports = { AICharacter, CODING_APPS, QUOTES };
