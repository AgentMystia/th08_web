import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('tests/.build', { recursive: true });
execSync(
  'npx esbuild src/game/th08-dialogue.ts --bundle --format=esm ' +
  '--outfile=tests/.build/th08-dialogue.mjs --log-level=silent'
);
const {
  Th08DialogueMachine,
  TH08_DIALOGUE_INPUT_BITS
} = await import('../tests/.build/th08-dialogue.mjs');

// Presenter-side portrait machinery (the runner-level behavior the stage
// host consumes for MSG ops 1/2/15/17). The face expression scripts park
// hidden at ins_23, enter through interrupt label 1, swap expressions via
// archive-flattened SetSprite ordinals, and exit through label 5.
execSync(
  'npx esbuild src/formats/anm.ts src/data/th08-data.ts --bundle --format=esm ' +
  '--outdir=tests/.build/th08-face --out-extension:.js=.mjs --log-level=silent'
);
const { Anm, AnmRunner } = await import('../tests/.build/th08-face/formats/anm.mjs');
const { TH08_DATA } = await import('../tests/.build/th08-face/data/th08-data.mjs');

function enterFaceRunner() {
  const faceAnm = new Anm(Buffer.from(TH08_DATA.anm.face_rm00, 'base64'), 'face_rm00');
  const entry = faceAnm.entries[1];
  const runner = new AnmRunner(faceAnm, entry.scriptIds[0], {
    entryIndex: 1,
    spriteIndexOffset: entry.spriteBase
  });
  return { faceAnm, runner };
}

test('face expression scripts park hidden and slide in via the enter label', () => {
  const { runner } = enterFaceRunner();
  runner.update();
  // The script head parks at ins_23 (hide + wait for interrupt): nothing
  // draws until the enter label fires.
  assert.equal(runner.spriteFrame(), null);
  assert.ok(runner.interrupt(1));
  for (let i = 0; i < 30; i++) runner.update();
  const frame = runner.spriteFrame();
  assert.ok(frame, 'portrait is visible after the 30-frame slide-in');
  assert.equal(frame.anchorTopLeft, true);
  assert.ok(Math.abs(frame.vmX - 48) < 0.01, `vmX settled at 48, got ${frame.vmX}`);
  assert.equal(frame.vmY, 128);
  assert.equal(frame.alpha, 255);
});

test('SetSprite ordinals swap the expression sprite without touching VM state', () => {
  const { runner } = enterFaceRunner();
  assert.ok(runner.interrupt(1));
  for (let i = 0; i < 30; i++) runner.update();
  const before = runner.spriteFrame();
  // Ordinal 6 = the 7th sprite in file order: entry0 carries sprite
  // ordinals 0-1 (the big declaration portrait), entries 1..8 one
  // expression sprite each — so 6 selects entry5's face texture.
  assert.ok(runner.setSpriteOrdinal(6));
  const after = runner.spriteFrame();
  assert.ok(after);
  assert.notEqual(after.imageKey, before.imageKey);
  assert.equal(after.w, 126);
  assert.equal(after.h, 254);
  assert.equal(after.alpha, 255);
  assert.equal(after.vmX, before.vmX);
  assert.equal(after.vmY, before.vmY);
});

test('the exit label fades the portrait out and ends its script', () => {
  const { runner } = enterFaceRunner();
  assert.ok(runner.interrupt(1));
  for (let i = 0; i < 30; i++) runner.update();
  assert.ok(runner.spriteFrame());
  assert.ok(runner.interrupt(5));
  let removed = false;
  for (let i = 0; i < 40 && !removed; i++) {
    runner.update();
    removed = runner.spriteFrame() === null;
  }
  assert.ok(removed, 'portrait removed after the exit slide');
});

function updateMany(machine, frames, input = 0) {
  const events = [];
  for (let frame = 0; frame < frames; frame++) {
    events.push(...machine.update(frame === 0 ? input : 0));
  }
  return events;
}

test('msg1a entry 0 follows the native speaker and slot semantic sequence', () => {
  const machine = new Th08DialogueMachine([
    { time: 0, op: 1, args: [0, 1] },

    { time: 60, op: 15, args: [0, 6, -1, -1, -1] },
    { time: 60, op: 16, text: 'line 1a' },
    { time: 60, op: 4, args: [500] },
    { time: 61, op: 1, args: [1, 1] },
    { time: 61, op: 15, args: [1, 2, 5, -1, -1] },
    { time: 61, op: 16, text: 'line 1b' },
    { time: 61, op: 16, text: 'line 1c' },
    { time: 61, op: 4, args: [500] },

    { time: 62, op: 17, args: [0, 7] },
    { time: 62, op: 16, text: 'line 1d' },
    { time: 62, op: 16, text: 'line 1e' },
    { time: 62, op: 4, args: [500] },

    { time: 63, op: 17, args: [0, 6] },
    { time: 63, op: 16, text: 'line 1f' },
    { time: 63, op: 4, args: [500] },
    { time: 63, op: 15, args: [2, -2, -2, -1, -1] },
    { time: 63, op: 3, args: [2, 0], text: 'legacy final line' },
    { time: 64, op: 4, args: [60] },
    { time: 0, op: 0 }
  ]);

  const events = updateMany(machine, 2500);
  const core = events.filter((event) => event.type !== 'wait-complete').map((event) => event.type);
  assert.deepEqual(core, [
    'portrait-init',
    'active-slot',
    'speaker-line',
    'wait-start',
    'portrait-init',
    'active-slot',
    'speaker-line',
    'speaker-line',
    'wait-start',
    'slot-update',
    'speaker-line',
    'speaker-line',
    'wait-start',
    'slot-update',
    'speaker-line',
    'wait-start',
    'active-slot',
    'legacy-text',
    'wait-start',
    'done'
  ]);

  const firstActive = events.find((event) => event.type === 'active-slot');
  assert.equal(firstActive.slot, 0);
  assert.deepEqual(firstActive.interrupts, [6, -1, -1, -1]);
  assert.deepEqual(firstActive.positions, [3, 4, 4, 4]);

  const secondActive = events.filter((event) => event.type === 'active-slot')[2];
  assert.equal(secondActive.slot, 2);
  assert.deepEqual(secondActive.positions, [6, 4, 3, 4]);

  const speakerLines = events.filter((event) => event.type === 'speaker-line');
  assert.deepEqual(speakerLines.map((event) => event.text), [
    'line 1a', 'line 1b', 'line 1c', 'line 1d', 'line 1e', 'line 1f'
  ]);
  assert.deepEqual(speakerLines.map((event) => event.speakerSlot), [0, 1, 1, 0, 0, 0]);
  assert.equal(machine.state.done, true);
});

test('op15 changes active slot while -1 interrupts remain unchanged', () => {
  const machine = new Th08DialogueMachine([
    { time: 0, op: 2, args: [0, 10] },
    { time: 0, op: 2, args: [1, 11] },
    { time: 0, op: 15, args: [0, 20, -1, -1, -1] },
    { time: 1, op: 15, args: [1, -1, 30, 31, -1] },
    { time: 2, op: 0 }
  ]);

  machine.update();
  const active = machine.update()[0];
  assert.equal(active.type, 'active-slot');
  assert.equal(active.slot, 1);
  assert.deepEqual(active.interrupts, [20, 30, 31, -1]);
  assert.deepEqual(active.positions, [4, 3, 4, 4]);
  assert.deepEqual(
    machine.state.portraits.map((portrait) => portrait.active),
    [false, true, false, false]
  );
});

test('op16 rotates two lines and a new speaker block restarts at line zero', () => {
  const machine = new Th08DialogueMachine([
    { time: 0, op: 15, args: [1, -1, -1, -1, -1] },
    { time: 0, op: 16, text: 'first' },
    { time: 0, op: 16, text: 'second' },
    { time: 1, op: 15, args: [3, -1, -1, -1, -1] },
    { time: 1, op: 16, text: 'replacement' },
    { time: 2, op: 0 }
  ]);

  const events = updateMany(machine, 4);
  const lines = events.filter((event) => event.type === 'speaker-line');
  assert.deepEqual(lines.map((event) => event.lineSlot), [0, 1, 0]);
  assert.deepEqual(lines[2].lines, ['replacement', null]);
  assert.equal(machine.state.currentSpeakerSlot, 3);
  assert.equal(machine.state.nextTextLine, 1);
});

test('op21 waits sixty frames and emits sound 12 on direction ownership switches', () => {
  const youkai = new Th08DialogueMachine([
    { time: 0, op: 21, args: [60] },
    { time: 0, op: 0 }
  ]);
  const youkaiEvents = updateMany(youkai, 61, TH08_DIALOGUE_INPUT_BITS.youkaiDirection);
  assert.deepEqual(youkaiEvents, [
    { type: 'ownership-switch', from: 0, to: 1 },
    { type: 'sound', id: 12 },
    { type: 'wait-start', duration: 60 },
    { type: 'wait-complete', duration: 60, confirmed: false },
    { type: 'done' }
  ]);
  assert.equal(youkai.state.ownershipSide, 1);
  assert.equal(youkai.state.done, true);

  const backToHuman = new Th08DialogueMachine(
    [{ time: 0, op: 21, args: [1] }, { time: 0, op: 0 }],
    { ownershipSide: 1 }
  );
  const humanEvents = backToHuman.update(TH08_DIALOGUE_INPUT_BITS.humanDirection);
  assert.deepEqual(humanEvents, [
    { type: 'ownership-switch', from: 1, to: 0 },
    { type: 'sound', id: 12 },
    { type: 'wait-start', duration: 1 }
  ]);
  assert.equal(backToHuman.state.waitRemaining, 0);
});

test('op22 writes ownership side to game mode and restarts message index', () => {
  const machine = new Th08DialogueMachine([
    { time: 0, op: 1, args: [2, 9] },
    { time: 1, op: 22 },
    { time: 2, op: 0 }
  ], { ownershipSide: 1, gameMode: 0 });

  machine.update(); // initial marker instruction
  const restart = machine.update();
  assert.deepEqual(restart, [
    { type: 'game-mode', side: 1 },
    { type: 'restart', instructionIndex: 0 }
  ]);
  assert.deepEqual(
    [machine.state.gameMode, machine.state.instructionIndex, machine.state.clock, machine.state.done],
    [1, 0, 0, false]
  );

  machine.update(); // replacement takes effect on the next scheduler pass
  const replay = machine.update(); // clock reaches the restarted marker
  assert.deepEqual(replay.map((event) => event.type), ['portrait-init']);
  assert.equal(replay[0].slot, 2);
  assert.equal(replay[0].script, 9);
});

test('ops 7 and 8 expose the native BGM switch and boss introduction payload', () => {
  const machine = new Th08DialogueMachine([
    { time: 0, op: 8, args: [2, 0], text: 'Darkness writhing light insect' },
    { time: 0, op: 7, args: [1] },
    { time: 1, op: 7, args: [-1] },
    { time: 2, op: 0 }
  ]);

  assert.deepEqual(machine.update(), [
    {
      type: 'boss-intro-line',
      color: 2,
      line: 0,
      text: 'Darkness writhing light insect'
    },
    { type: 'music-change', slot: 1 }
  ]);
  assert.deepEqual(machine.update(), [{ type: 'music-change', slot: -1 }]);
  assert.deepEqual(machine.update(), [{ type: 'done' }]);
});

test('waits are skippable by default (msg-init skippable=1, all.c:24649)', () => {
  // No op13 at all: the RunMsg init defaults skippable to 1, so a held-Ctrl
  // update bypasses the op4 body on contact.
  const machine = new Th08DialogueMachine([
    { time: 0, op: 16, text: 'a' },
    { time: 0, op: 4, args: [500] },
    { time: 1, op: 16, text: 'b' },
    { time: 1, op: 0 }
  ]);
  machine.update(); // clock 0: text + wait armed (500-frame wait blocks)
  assert.equal(machine.state.waiting, true);
  const events = machine.update(TH08_DIALOGUE_INPUT_BITS.fastForward);
  assert.ok(events.some((e) => e.type === 'wait-complete'), 'Ctrl bypasses the wait');
  assert.equal(machine.state.done, false, 'op0 sits one clock tick out');
  machine.update(TH08_DIALOGUE_INPUT_BITS.fastForward);
  assert.equal(machine.state.done, true);
});


test('the Ctrl warp advances ONE @block per update (gui-run-msg.c:33-35)', () => {
  // The loop-head SetCurrent targets only the pending instruction's time, so
  // a held-Ctrl run processes one timestamped block per scheduler frame.
  const FF = TH08_DIALOGUE_INPUT_BITS.fastForward;
  const machine = new Th08DialogueMachine([
    { time: 0, op: 16, text: 'a' },
    { time: 0, op: 4, args: [500] },
    { time: 60, op: 16, text: 'b' },
    { time: 60, op: 4, args: [500] },
    { time: 120, op: 16, text: 'c' },
    { time: 120, op: 0 }
  ]);
  machine.update(); // t0 block; the 500-frame wait parks, clock frozen at 0
  machine.update(FF); // pending op sits at t0: no warp; the wait bypasses
  assert.equal(machine.state.lines[0], 'a');
  machine.update(FF); // warp to t=60: text b + its wait bypassed
  assert.equal(machine.state.lines[0], 'b');
  assert.equal(machine.state.done, false, 'the t=120 block waits for the next update');
  machine.update(FF); // warp to t=120: text c + op0
  assert.equal(machine.state.done, true);
});

test('confirm threshold: 6 at load, 8 after a confirm, 30 after a timeout', () => {
  // gui+0x21830: init 6 (all.c:24650), re-armed 8 on a confirm release and
  // 30 on a natural timeout (asm 0x434c46/0x434c86). The wait counter runs
  // from the text op, and only a genuine Z EDGE (release+repress) releases.
  const CF = TH08_DIALOGUE_INPUT_BITS.confirm;
  const machine = new Th08DialogueMachine([
    { time: 0, op: 16, text: 'a' },
    { time: 0, op: 4, args: [500] },
    { time: 1, op: 16, text: 'b' },
    { time: 1, op: 4, args: [500] },
    { time: 2, op: 16, text: 'c' },
    { time: 2, op: 4, args: [3] },
    { time: 3, op: 16, text: 'd' },
    { time: 3, op: 4, args: [500] },
    { time: 4, op: 0 }
  ]);
  const seq = (steps) => {
    let last;
    for (const input of steps) last = machine.update(input);
    return last;
  };
  const idle = (n) => seq(Array.from({ length: n }, () => 0));

  // Wait 1 (threshold 6): edge at counter 5 does nothing, at 6 releases.
  seq([0]); // text a; wait parks (counter 1)
  idle(4); // counter 5
  seq([CF]); // edge, 5 < 6: no release (counter 6)
  assert.equal(machine.state.lines[0], 'a', 'no release below the init 6');
  seq([0]); // Z back up (edges need a repress); counter 7
  seq([CF]); // edge, 7 >= 6: release (arm 8); the tail ticks the clock to 1
  seq([0]); // text b; wait parks (counter 1)

  // Wait 2 (threshold 8): edge at 7 does nothing, at 8 releases.
  idle(6); // counter 7
  seq([CF]); // edge, 7 < 8: no release (counter 8)
  assert.equal(machine.state.lines[0], 'b', 'no release below the re-armed 8');
  seq([0]); // counter 9
  seq([CF]); // edge, 9 >= 8: release; clock ticks to 2
  seq([0]); // text c; the 3-frame wait parks (counter 1)

  // Wait 3 (duration 3): natural timeout re-arms 30; text d parks same pass.
  idle(3); // counter 2, 3 → timeout at 3; clock ticks to 3
  seq([0]); // text d; wait parks (counter 1)

  // Wait 4 (threshold 30): edge at 29 does nothing, at 30 releases.
  idle(28); // counter 29
  seq([CF]); // edge, 29 < 30: no release (counter 30)
  assert.equal(machine.state.lines[0], 'd', 'no release below the re-armed 30');
  seq([0]); // counter 31
  seq([CF]); // edge, 31 >= 30: release; clock ticks to 4
  seq([0]); // op0 at clock 4
  assert.equal(machine.state.done, true);
});
