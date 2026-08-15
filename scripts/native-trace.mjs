#!/usr/bin/env node
// Native TH08 PRE-trace under wine + winedbg gdb stub + gdb breakpoint
// commands (auto-print + auto-continue; ONE 'cont' drives the window).
// Evidence plan: AGENTS.md §5 — the original engine's per-event state is the
// convergence oracle for TH08 Stage 1. Output: /tmp/native-trace.txt.
// Usage: node scripts/native-trace.mjs [seconds]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';

const SECONDS = Number(process.argv[2] ?? 600);
const ROOT = '/tmp/th08-native';
const SRC = '/workspace/reference/th08-original/th08';
const REPLAY = '/workspace/replay/th8_udLy01.rpy';
const OUT = '/tmp/native-trace.txt';
const GDB_PORT = 31337;

if (!existsSync(SRC) || !existsSync(REPLAY)) {
  console.error('missing native build or replay');
  process.exit(2);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
cpSync(SRC, ROOT, { recursive: true });
mkdirSync(`${ROOT}/demo`, { recursive: true });
cpSync(REPLAY, `${ROOT}/demo/demorpy0.rpy`);

const gdbCmds = `
set pagination off
set confirm off
set $ev = 0
set $rng = 0
target remote :${GDB_PORT}

break *0x004a619e
commands
  silent
  set $ev = $ev + 1
  printf "ev=%d ENTRY\\n", $ev
  cont
end

break *0x0043ecc0
commands
  silent
  set $rng = $rng + 1
  cont
end

break *0x0042a680
commands
  silent
  set $ev = $ev + 1
  set $pos = *(int*)($esp+4)
  printf "ev=%d SPAWN sub=%d x=%f y=%f life=%d item=%d score=%d\\n", $ev, $edx, *(float*)$pos, *(float*)($pos+4), *(int*)($esp+8), *(int*)($esp+12), *(int*)($esp+16)
  cont
end

break *0x0042f5f0
commands
  silent
  set $ev = $ev + 1
  printf "ev=%d FIRE type=%d off=%d ways=%d stacks=%d speed=%f angle=%f\\n", $ev, *(short*)$ecx, *(short*)($ecx+2), *(short*)($ecx+0x1f4), *(short*)($ecx+0x1f6), *(float*)($ecx+0x18), *(float*)($ecx+0x10)
  cont
end

break *0x00422720
commands
  silent
  set $ev = $ev + 1
  printf "ev=%d FIREBUILD sprite=%d offset=%d\\n", $ev, *(short*)$edx, *(short*)($edx+2)
  cont
end

cont
`;
writeFileSync('/tmp/native-trace.gdb', gdbCmds);

console.log(`native-trace: staged ${ROOT}, window ${SECONDS}s`);
const xvfb = spawn('Xvfb', [':98', '-screen', '0', '1280x960x24'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2000));
const env = { ...process.env, DISPLAY: ':98', XDG_RUNTIME_DIR: '/tmp/xdg', WINEDEBUG: '-all' };
mkdirSync('/tmp/xdg', { recursive: true });

const dbg = spawn('winedbg', ['--gdb', '--port', String(GDB_PORT), '--no-start', 'th08.exe'], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
});
let dbgLog = '';
dbg.stdout.on('data', (d) => { dbgLog += d; });
dbg.stderr.on('data', (d) => { dbgLog += d; });
await new Promise((r) => setTimeout(r, 6000));

const gdb = spawn('gdb', ['--batch', '-x', '/tmp/native-trace.gdb'], {
  env: process.env, stdio: ['ignore', 'pipe', 'pipe']
});
const out = spawn('tee', [OUT], { stdio: ['pipe', 'ignore', 'ignore'] });
let gdbRaw = '';
gdb.stdout.on('data', (d) => { gdbRaw += d; out.stdin.write(d); });
gdb.stderr.on('data', (d) => { gdbRaw += d; out.stdin.write(d); });

await new Promise((r) => setTimeout(r, SECONDS * 1000));
gdb.kill('SIGKILL');
dbg.kill('SIGKILL');
xvfb.kill('SIGKILL');
out.stdin.end();

const trace = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
const lines = trace.trim().split('\n').filter(Boolean);
const spawns = lines.filter((l) => l.includes('SPAWN')).length;
const fires = lines.filter((l) => l.includes('FIRE')).length;
const entry = lines.some((l) => l.includes('ENTRY'));
console.log(`trace: ${lines.length} lines, entry=${entry}, spawns=${spawns}, fires=${fires} -> ${OUT}`);
console.log('gdb tail:', gdbRaw.trim().split('\n').slice(-3).join(' | '));
console.log('winedbg tail:', dbgLog.trim().split('\n').slice(-2).join(' | '));
