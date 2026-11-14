// Copies the real Run My Agents board page into the bot, so bot.flisk.si is that board (animated faces, feed, the lot)
// and not a lookalike. Nothing is duplicated by hand: this writes one generated file from the run-my-agents checkout.
//   bun scripts/sync-rma.ts [path to run-my-agents]     default: ../run-my-agents
// Re-run it after the board page changes in run-my-agents, then commit services/bot/bot/src/rma.generated.ts.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || join(import.meta.dir, '..', '..', 'run-my-agents'));
const app = join(root, 'services', 'app');
const { PAGE } = await import(join(app, 'board', 'src', 'page.ts'));
const { GEIST, GEIST_MONO } = await import(join(app, 'board', 'src', 'fonts.generated.ts'));
const { AGENTS } = await import(join(app, 'web', 'src', 'avatars.ts'));

const faces = Object.fromEntries(AGENTS.map((a: any) => [a.role, { shape: a.shape, eyes: a.eyes, color: a.color, extra: a.extra }]));
const sha = (await Bun.$`git -C ${root} rev-parse --short HEAD`.text()).trim();
const out = join(import.meta.dir, '..', 'services', 'bot', 'bot', 'src', 'rma.generated.ts');
writeFileSync(
  out,
  `// Written by scripts/sync-rma.ts from flisk-sh/run-my-agents@${sha}. Do not edit.\n` +
    `export const PAGE = ${JSON.stringify(PAGE)};\n` +
    `export const FONTS: Record<string, string> = ${JSON.stringify({ 'geist.woff2': GEIST, 'geist-mono.woff2': GEIST_MONO })};\n` +
    `export const FACES: Record<string, { shape: string; eyes: string; color: string; extra?: string }> = ${JSON.stringify(faces)};\n`,
);
console.log('wrote', out, `(${Math.round(PAGE.length / 1024)} KB page, run-my-agents@${sha})`);
