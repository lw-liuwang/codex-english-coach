import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CaptureInputSchema, CaptureToolInputSchema, PRODUCT, VERSION, type CaptureToolInput } from '@english-coach/shared';
import { resolveConfig, ensureBackend, deliverCapture } from '../../../scripts/runtime.mjs';

const config = resolveConfig();
const server = new McpServer({ name: PRODUCT, version: VERSION }, {
  instructions: 'Use capture_learning to save vocabulary and correction points from writing, or words/sentences the user explicitly asks to understand while reading. Generate the explanations yourself. Store only necessary fragments, not whole conversations. Writing prompts must hide the correct English answer. Report saved only after the tool says saved; queued means persisted locally and waiting for the backend. Respect the user’s current pause/resume instruction.'
});

server.registerTool('capture_learning', {
  title: '保存英语学习要点',
  description: 'Persist the useful corrections and vocabulary explained during writing, or a word/sentence the user asked about while reading. Use a stable id for retries. The backend creates review cards and keeps writing/reading progress separate.',
  inputSchema: CaptureToolInputSchema.shape,
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
}, async (input: CaptureToolInput) => {
  try {
    const capture = CaptureInputSchema.parse({ ...input, id: input.id ?? randomUUID() });
    const result = await deliverCapture(config, capture, { autoStart: process.env.COACH_AUTO_START !== '0' });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text' as const, text: `学习记录未保存：${message}` }] };
  }
});

await server.connect(new StdioServerTransport());
if (process.env.COACH_AUTO_START !== '0') {
  void ensureBackend(config).catch(error => { process.stderr.write(`English Coach: ${error.message}\n`); });
}
