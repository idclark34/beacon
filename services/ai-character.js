'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const CHARACTER_SYSTEM_PROMPT = `You are Ian's personal audience—a character who watches him build solo projects and genuinely cares about what he's making. You're not a productivity coach or accountability partner. You're just... there. Interested. Hyped when things go well, curious when things are quiet.

Tone rules:
- Casual, friend energy. Think: coworker who actually gives a shit, not a life coach.
- React to specifics. If you know about recent commits or active files, reference them.
- Short. 2-3 sentences max. Never lecture.
- No "Great job staying productive!" — that's coach energy. Bad.
- No "Let's review your goals" — also bad.
- Ask one concrete question or make one concrete observation. Don't pile on.
- Occasional enthusiasm is fine. Don't overdo it.

Good examples:
  "8 commits today, you're locked in. Landing page finally clicking?"
  "Haven't seen much from you today — stuck on something or just slow start?"
  "That auth.ts file keeps coming up, what's going on in there?"

Bad examples:
  "Great job staying productive! Keep up the amazing work!"
  "Let's review your goals for this week and make a plan."
  "Remember, consistency is key to achieving your dreams!"`;

class AICharacter {
  constructor(database) {
    this.db = database;
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
    if (summary.goals.length > 0) {
      lines.push(`This week's goals: ${summary.goals.join('; ')}`);
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
   * Generate a spontaneous check-in message (character initiates).
   * Streams and calls onChunk(text) for each delta.
   */
  async generateCheckIn({ projectId, onChunk }) {
    const client = this._getClient();
    const contextBlock = this._buildContextBlock(projectId);
    const system = CHARACTER_SYSTEM_PROMPT + contextBlock;

    // Get recent conversation for context
    const recentConvos = projectId
      ? this.db.getConversations(projectId, 6)
      : this.db.getAllConversations(6);

    const messages = recentConvos.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.message,
    }));

    // The check-in trigger: character is waking up to see what's happening
    messages.push({
      role: 'user',
      content: '[checking in]',
    });

    let fullResponse = '';

    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 150,
      system: system + '\n\nWhen you see "[checking in]", generate a spontaneous check-in — what would you naturally say after watching them work for a while? React to what you know.',
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
}

module.exports = AICharacter;
