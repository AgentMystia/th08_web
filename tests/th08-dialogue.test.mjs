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
