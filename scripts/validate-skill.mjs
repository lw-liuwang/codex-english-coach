import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const skillDir = resolve(root, 'skills/codex-english-coach');
const skill = await readFile(resolve(skillDir, 'SKILL.md'), 'utf8');
const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(skill);
assert.ok(frontmatter, 'SKILL.md must have YAML frontmatter');
const metadata = parse(frontmatter[1]);
assert.equal(metadata.name, 'codex-english-coach');
assert.ok(typeof metadata.description === 'string' && metadata.description.length > 0 && metadata.description.length <= 1024);
assert.ok(!/\[TODO\]|TODO:|PLACEHOLDER/.test(skill), 'Skill contains unfinished scaffold text');
const ui = parse(await readFile(resolve(skillDir, 'agents/openai.yaml'), 'utf8'));
assert.equal(ui.policy.allow_implicit_invocation, true);
assert.ok(ui.interface.default_prompt.includes('$codex-english-coach'));
assert.ok(ui.interface.short_description.length >= 25 && ui.interface.short_description.length <= 64);
for (const match of skill.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
  if (/^[a-z]+:|^#/.test(match[1])) continue;
  await access(resolve(skillDir, match[1].split('#')[0]));
}
console.log('Skill metadata, local references, and invocation policy are valid.');
