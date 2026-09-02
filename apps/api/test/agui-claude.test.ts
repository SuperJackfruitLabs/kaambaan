import { describe, it, expect } from 'vitest';
import { normalizeClaudeStreamLine } from '@kaambaan/agent-sdk';

/**
 * docs/05 §6 / docs/07 §1: an adapter translates a harness's native stream into the normalized
 * activity envelope the Board DO ingests. This is the Claude Code `--output-format stream-json` case.
 */
describe('normalizeClaudeStreamLine (Claude Code stream-json)', () => {
  it('maps an assistant text message to a thought, carrying token usage', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-opus-4-8', content: [{ type: 'text', text: 'Looking into it' }], usage: { input_tokens: 1200, output_tokens: 300 } },
    });
    expect(normalizeClaudeStreamLine(line)).toEqual([
      { type: 'thought', body: 'Looking into it', ephemeral: true, usage: { model: 'claude-opus-4-8', inputTokens: 1200, outputTokens: 300 } },
    ]);
  });

  it('maps a tool_use block to an action', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
    });
    expect(normalizeClaudeStreamLine(line)).toEqual([{ type: 'action', action: 'Bash', parameter: { command: 'ls' } }]);
  });

  it('attaches message usage to only the first activity (no double counting)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'Running a command' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
        usage: { input_tokens: 50, output_tokens: 10 },
      },
    });
    const out = normalizeClaudeStreamLine(line);
    expect(out).toHaveLength(2);
    expect(out[0]!.usage).toBeDefined();
    expect(out[1]!.usage).toBeUndefined();
  });

  it('maps the final result to a response with cost', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      total_cost_usd: 0.07,
      usage: { input_tokens: 5000, output_tokens: 800 },
      model: 'claude-opus-4-8',
    });
    expect(normalizeClaudeStreamLine(line)).toEqual([
      { type: 'response', body: 'done', usage: { model: 'claude-opus-4-8', inputTokens: 5000, outputTokens: 800, costUsd: 0.07 } },
    ]);
  });

  it('maps an error result to an error activity', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: 'boom', total_cost_usd: 0.01 });
    expect(normalizeClaudeStreamLine(line)[0]!.type).toBe('error');
  });

  it('omits usage when a result carries no cost or token data (no unpriced-record noise)', () => {
    const out = normalizeClaudeStreamLine(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }));
    expect(out[0]!.type).toBe('response');
    expect(out[0]!.usage).toBeUndefined();
  });

  it('ignores blank lines, unparseable lines, and unmodeled event types', () => {
    expect(normalizeClaudeStreamLine('')).toEqual([]);
    expect(normalizeClaudeStreamLine('not json')).toEqual([]);
    expect(normalizeClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
  });
});
