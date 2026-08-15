#!/usr/bin/env node
// Native TH08 PRE-trace: drives winedbg's interactive prompt (not the gdb
// stub) over stdin/stdout. See AGENTS.md §5 for the convergence workflow.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, createWriteStream } from 'node:fs';

const SECONDS = Number(process.argv[2] ?? 240);
const ROOT = '/tmp/th08-native';
const SRC = '/workspace/reference/th08-original/th08';
const REPLAY = '/workspace/replay/th8_udLy01.rpy';
const OUT = '/tmp/native-trace.txt';

if (!existsSync(SRC) || !existsSync(REPLAY)) {
  console.error('missing native build or replay');
  process.exit(2);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
cpSync(SRC, ROOT, { recursive: true });
mkdirSync(`${ROOT}/demo`, { recursive: true });
cpSync(REPLAY, `${ROOT}/demo/demorpy0.rpy`);

console.log(`native-trace: staged ${ROOT}, window ${SECONDS}s`);
const xvfb = spawn('Xvfb', [':98', '-screen', '0', '1280x960x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));
const env = { ...process.env, DISPLAY: ':98', XDG_RUNTIME_DIR: '/tmp/xdg', WINEDEBUG: '-all' };
mkdirSync('/tmp/xdg', { recursive: true });

const out = createWriteStream(OUT, { flags: 'w' });
let ev = 0;
let rngDraws = 0;
const log = (line) => { ev++; out.write(`ev=${ev} ${line}\n`); };

const dbg = spawn('winedbg', ['th08.exe'], { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
let stopped = false;
let hits = 0;

const send = (cmd) => dbg.stdin.write(cmd + '\n');

dbg.stderr.on('data', () => {});
dbg.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('Wine-dbg>')) >= 0) {
    const before = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 9);
    if (stopped) continue;
    stopped = true;
    hits++;
    if (hits <= 4) log('STOP raw: ' + before.trim().slice(-160).replace(/\n/g, ' '));
    if (before.includes('43ecc0')) {
      rngDraws++;
      send('cont');
      stopped = false;
    } else if (before.includes('42a680')) {
      send('print $edx');
      send('x/2fw *(int*)($esp+4)');
      send('print *(int*)($esp+8)');
      send('print *(int*)($esp+12)');
      send('print *(int*)($esp+16)');
      log('SPAWN hit');
      send('cont');
      stopped = false;
    } else if (before.includes('42f5f0')) {
      log('FIRE hit');
      send('cont');
      stopped = false;
    } else {
      send('cont');
      stopped = false;
    }
  }
});

const waitForPrompt = () => new Promise((resolve) => {
  const check = () => (buffer.includes('Wine-dbg>') ? resolve() : setTimeout(check, 100));
  check();
});
await waitForPrompt();
buffer = '';
send('break *0x0043ecc0');
send('break *0x0042a680');
send('break *0x0042f5f0');
log('TRACE-BEGIN');
send('cont');

await new Promise((r) => setTimeout(r, SECONDS * 1000));
log(`TRACE-END rng_draws=${rngDraws} breakpoint_hits=${hits}`);
out.end();
dbg.kill('SIGKILL');
xvfb.kill('SIGKILL');
console.log(`trace: ${ev} events, ${rngDraws} rng draws, ${hits} breakpoint stops -> ${OUT}`);
