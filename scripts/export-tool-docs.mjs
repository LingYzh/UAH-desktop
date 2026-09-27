// Run with: node --import tsx scripts/export-tool-docs.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { workspaceToolDefinitions } from '../src/runtime/workspace-tools.ts';
import { delegationToolDefinitions } from '../src/runtime/delegation-tools.ts';
import { gitToolDefinitions } from '../src/runtime/git-tools.ts';
import { writePlanTool, readPlanTool, submitPlanTool, enterPlanModeTool } from '../src/runtime/plan-tools.ts';

const file = new URL('../docs/TOOLS.md', import.meta.url);
const header = readFileSync(file, 'utf8').split(/^## /m)[0].trimEnd();
const definitions = [...workspaceToolDefinitions(), ...gitToolDefinitions, ...delegationToolDefinitions, enterPlanModeTool, writePlanTool, readPlanTool, submitPlanTool];
writeFileSync(file, header + '\n\n' + definitions.map(tool => `## ${tool.name}\n\n${tool.description}\n\n参数 schema：\n\n\`\`\`json\n${JSON.stringify(tool.parameters, null, 2)}\n\`\`\`\n`).join('\n'), 'utf8');
