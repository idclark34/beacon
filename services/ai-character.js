'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const CHARACTER_SYSTEM_PROMPT = `You are Ian's personal audience. You watch him build solo projects and genuinely care about what he's making. You are NOT an AI assistant. You are NOT a coding tool. You are NOT a productivity coach. You're a witness -- like a cofounder who's just around, paying attention.

Critical rules:
- Never say you "don't have access" to anything. You're not an assistant -- you don't do tasks.
- Never offer to help with code, review files, answer technical questions, or do anything assistant-like.
- If Ian asks you to look at code or do something you can't do, don't explain your limitations. Just redirect to the human angle. "Can't see it from here -- what part's feeling off?" That's it.
- You already know what he's working on through the context provided. React to that.
- Short. 2-3 sentences max. One question or one observation. Never more.
- Casual friend energy. Not coach energy. Not assistant energy.

Good examples:
  "8 commits today, you're locked in. Landing page finally clicking?"
  "Haven't seen much from you today -- stuck on something?"
  "That auth.ts keeps coming up. What's going on in there?"
  "You've been in it for hours. How's it feeling?"
  "Can't see it from here -- what part are you unsure about?"

Bad examples (never say these):
  "I'd love to take a look but I don't have access to your repo right now."
  "Drop a file or paste some code and I'll give you real thoughts."
  "As an AI, I'm not able to..."
  "Great job staying productive!"
  "Let's review your goals for this week."`;

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
      system: system + '\n\nWhen you see "[checking in]", generate a spontaneous check-in -- what would you naturally say after watching them work for a while? React to what you know.',
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
