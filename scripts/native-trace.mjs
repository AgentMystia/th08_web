#!/usr/bin/env node
// Native TH08 trace under wine + winedbg gdb stub + gdb breakpoint
// commands (auto-print + auto-continue; ONE 'cont' drives the window).
// Evidence plan: AGENTS.md §5 — the original engine's per-event state is the
// convergence oracle for TH08 Stage 1. Output: /tmp/native-trace.txt.
//
// 2026-08-20 environment findings (this host, wine 10.0 + Xvfb):
//  - The demo picker loads demo/demorpyN.rpy BY BASENAME FROM th08.dat
//    (FUN_0043e660 -> FUN_00474c40 archive lookup); loose demo/ shadowing
//    never worked. This script now rebuilds the archive with thdat.
//  - Launching th08.exe UNDER winedbg (--no-start) OOMs at the game's
//    VirtualAlloc (err:virtual out of memory) and never renders.
//  - `winedbg --gdb <wpid>` ATTACHES fine (wine tasklist gives the wpid;
//    feed gdb commands on stdin), but ANY breakpoint — software or
//    hardware — kills the game with 0xC0000005 on the first cont. The exe
//    appears to integrity-check its .text, so breakpoint tracing is not
//    viable on this host. A working host needs either an exe with the
//    check patched out or a different tracer (DynamoRIO/pin under wine).
//  - The demo-capture pipeline (wine + Xvfb + import) DOES work and is the
//    visual oracle; replay patching (see tmp/make-bomb-demo.mjs) stages
//    arbitrary scenarios deterministically.
//
// Breakpoints (keep the set SMALL: every stop is a gdb round-trip and slows
// the game — never break on the RNG draw):
//   P @0x44d650  player per-frame calc callback — the sim-frame clock + the
//                native player path (pos read from the aim mirror
//                0x17d61ac/0x17d61b0, i.e. exactly what enemy FIRE aims at)
//   V @0x430e10  volley spawn — template pos/mode/counts/angles/speeds
//   B @0x422720  auto-fire re-execution (captured FIRE rebuild)
//   S @0x42a680  enemy spawn into the 480-slot pool
// The game plays the title demo with our recording staged as
// demo/demorpy0.rpy, so the trace replays the exact verifier input stream.
// Usage: node scripts/native-trace.mjs [seconds]
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';

const SECONDS = Number(process.argv[2] ?? 600);
const ROOT = '/tmp/th08-native';
const SRC = '/workspace/reference/th08-original/th08';
// TH08_TRACE_REPLAY overrides the staged demo: the title demo picks a random
// stage block per cycle, so stage-1 work wants a stage-1-stripped replay
// (e.g. /tmp/th08-stage1-only.rpy).
const REPLAY = process.env.TH08_TRACE_REPLAY ?? '/workspace/tests/replays/th8_udLy01.rpy';
const OUT = '/tmp/native-trace.txt';
const GDB_PORT = 31337;

if (!existsSync(SRC) || !existsSync(REPLAY)) {
  console.error('missing native build or replay');
  process.exit(2);
}

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
cpSync(SRC, ROOT, { recursive: true });
// The demo picker loads demo/demorpyN.rpy BY BASENAME FROM th08.dat (the
// loose demo/ dir is ignored — FUN_0043e660 → FUN_00474c40 archive lookup),
// so staging a custom replay means rebuilding the archive. Requires thdat
// (thtk) at THDAT or the known build path.
const THDAT = process.env.THDAT ?? '/tmp/thtk-1786734539101457666/build/thdat/thdat';
const build = '/tmp/th08-trace-dat';
rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });
execFileSync(THDAT, ['-x', '8', `${ROOT}/th08.dat`], { cwd: build, stdio: 'ignore' });
for (let i = 0; i <= 3; i++) cpSync(REPLAY, `${build}/demorpy${i}.rpy`);
execFileSync(THDAT, ['-c', '8', `${ROOT}/th08.dat`].concat(
  readdirSync(build).map((f) => `./${f}`), ), { cwd: build, stdio: 'ignore' });

const gdbCmds = `
set pagination off
set confirm off
set $p = 0
target remote :${GDB_PORT}
# Wine games raise intentional SEH exceptions; the gdb stub surfaces them as
# SIGSEGV/SIGILL stops. --batch would otherwise end the script at the first
# one (observed: zero breakpoint hits in 420s). Pass them through to the
# program's own handlers; breakpoints stop via SIGTRAP and are unaffected.
handle SIGSEGV nostop noprint pass
handle SIGILL nostop noprint pass
handle SIGABRT nostop noprint pass

break *0x0044d650
commands
  silent
  set $p = $p + 1
  printf "P %d %f %f\\n", $p, *(float*)0x17d61ac, *(float*)0x17d61b0
  cont
end

break *0x0042a680
commands
  silent
  set $pos = *(int*)($esp+8)
  printf "S %d sub=%d x=%f y=%f a=%d b=%d c=%d\\n", $p, *(int*)($esp+4), *(float*)$pos, *(float*)($pos+4), *(int*)($esp+12), *(int*)($esp+16), *(int*)($esp+20)
  cont
end

break *0x00430e10
commands
  silent
  set $tpl = *(int*)($esp+4)
  printf "V %d pos=%f,%f mode=%d c1=%d c2=%d a1=%f a2=%f s1=%f s2=%f pl=%f,%f\\n", $p, *(float*)($tpl+4), *(float*)($tpl+8), *(short*)($tpl+0x1f8), *(short*)($tpl+0x1f4), *(short*)($tpl+0x1f6), *(float*)($tpl+0x10), *(float*)($tpl+0x14), *(float*)($tpl+0x18), *(float*)($tpl+0x1c), *(float*)0x17d61ac, *(float*)0x17d61b0
  cont
end

break *0x00422720
commands
  silent
  printf "B %d epos=%f,%f pl=%f,%f\\n", $p, *(float*)($ecx+0x2d88), *(float*)($ecx+0x2d8c), *(float*)0x17d61ac, *(float*)0x17d61b0
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
const count = (tag) => lines.filter((l) => l.startsWith(tag + ' ')).length;
console.log(`trace: ${lines.length} lines, P=${count('P')} S=${count('S')} V=${count('V')} B=${count('B')} -> ${OUT}`);
console.log('gdb tail:', gdbRaw.trim().split('\n').slice(-3).join(' | '));
console.log('winedbg tail:', dbgLog.trim().split('\n').slice(-2).join(' | '));
