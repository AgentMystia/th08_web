// TH08 verification orchestrator.
//   fast: check + build + test + clean browser boot
//   edit: check + focused tests (--test a,b) + clean browser boot
//   full: fast + the replay convergence gate + TH08 pixel spot checks +
//         the static Pages boot
// The replay gate runs the committed fixture tests/replays/th8_udLy01.rpy;
// PASS there is the vertical slice's acceptance oracle (see AGENTS.md §0).
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'fast';
const argv = process.argv.slice(3);

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i++) {
    const match = /^--([a-z-]+)$/.exec(values[i]);
    if (!match) continue;
    const next = values[i + 1];
    if (next == null || next.startsWith('--')) out[match[1]] = true;
    else { out[match[1]] = next; i++; }
  }
  return out;
}

function run(command, args, label = `${command} ${args.join(' ')}`) {
  console.log(`\n[verify] ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal ?? code})`));
    });
  });
}

const npm = (script, extra = []) => run('npm', ['run', script, '--', ...extra], `npm run ${script}`);

async function fast() {
  await Promise.all([
    npm('check'),
    npm('build'),
    run('npm', ['test'], 'npm test')
  ]);
  await run('node', ['scripts/dev-shot.mjs', '/tmp/th08-verify-boot.png', '300'], 'clean browser boot');
}

async function edit() {
  const args = parseArgs(argv);
  const tests = args.test ? String(args.test).split(',') : [];
  await Promise.all([
    npm('check'),
    tests.length
      ? run('node', ['--test', ...tests], `related tests: ${tests.join(', ')}`)
      : run('npm', ['test'], 'npm test')
  ]);
}

async function full() {
  await fast();
  await npm('replay:verify:th08');
  // TH08 pixel spot checks (AGENTS.md §0's oracle table). The play/side/lower
  // bands are 640x480 game coords — dev-shot screenshots are 1280x960, so the
  // regions are passed at 2x. Reports are printed for review against the
  // baseline table; tolerances ±12 brightness / ±10 texture %.
  const shots = [
    ['300', '', 'boot / early HUD'],
    ['800', 'difficulty=3', 'fairies live'],
    ['2500', 'difficulty=3&shoot', 'dense waves'],
    ['4600', 'difficulty=3', 'boss danmaku']
  ];
  for (const [frame, query, label] of shots) {
    const file = `/tmp/th08-full-${frame}.png`;
    await run('node', ['scripts/dev-shot.mjs', file, frame, query, 'shoot'], `TH08 frame ${frame} (${label})`);
    await run('node', [
      'scripts/pixel-report.mjs', file,
      '64,32,768,896:play', '848,32,400,896:side', '64,896,768,32:lower'
    ], `pixel report ${frame} (${label})`);
  }
  await npm('prepare-pages');
  await run('node', ['scripts/browser-boot.mjs', 'dist/pages', '300'], 'static Pages boot');
}

try {
  if (mode === 'edit') await edit();
  else if (mode === 'fast') await fast();
  else if (mode === 'full') await full();
  else throw new Error(`unknown verify mode: ${mode}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
