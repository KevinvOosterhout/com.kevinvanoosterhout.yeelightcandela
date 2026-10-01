import assert from 'node:assert/strict';
import test from 'node:test';
import CandelaBle, {
  brightnessCommand, powerCommand, isCandela,
} from '../.homeybuild/lib/candela-ble.js';
import CandelaController, { patternDim } from '../.homeybuild/lib/candela-controller.js';

function fixture(initial = {}) {
  const writes = [];
  const states = [];
  const timers = new Map();
  let nextTimer = 1;
  const transport = {
    async write(packets, keepConnected) {
      writes.push({ packets, keepConnected });
    },
    async probe() {},
    async close() {},
  };
  const availability = [];
  const controller = new CandelaController(
    transport,
    { on: false, dim: 0.5, pattern: 'steady', ...initial },
    {
      async state(state) { states.push(state); },
      async available() { availability.push(true); },
      async unavailable() { availability.push(false); },
      setTimeout(callback, ms) {
        const id = nextTimer++;
        timers.set(id, { callback, ms });
        return id;
      },
      clearTimeout(id) { timers.delete(id); },
    },
  );
  return {
    controller, transport, writes, states, timers, availability,
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
      await new Promise(setImmediate);
    },
  };
}

test('Candela packets use 18 bytes with the correct power and brightness opcodes', () => {
  for (const [packet, prefix] of [
    [powerCommand(true), [0x43, 0x40, 1]],
    [powerCommand(false), [0x43, 0x40, 2]],
    [brightnessCommand(0.5), [0x43, 0x42, 50]],
    [brightnessCommand(0.001), [0x43, 0x42, 1]],
    [brightnessCommand(1), [0x43, 0x42, 100]],
  ]) {
    assert.equal(packet.length, 18);
    assert.deepEqual([...packet.subarray(0, 3)], prefix);
    assert.ok(packet.subarray(3).every(byte => byte === 0));
  }
  for (const invalid of [0, -1, NaN, Infinity, 1.01]) {
    assert.throws(() => brightnessCommand(invalid));
  }
});

test('discovery excludes bedside lamps and non-connectable advertisements', () => {
  assert.ok(isCandela({ localName: 'yeelight_ms', connectable: true }));
  assert.ok(isCandela({ localName: 'YEELIGHT_MS_1234', connectable: true }));
  for (const localName of ['XMCTD_1234', 'Yeelight', undefined, 'yeelight_msdifferent']) {
    assert.equal(isCandela({ localName, connectable: true }), false);
  }
  assert.equal(isCandela({ localName: 'yeelight_ms', connectable: false }), false);
});

test('zero brightness turns off and power-on restores the last positive brightness', async () => {
  const f = fixture();
  await f.controller.setDim(0.32);
  await f.controller.setDim(0);
  assert.equal(f.writes[1].packets.length, 1);
  assert.equal(f.writes[1].packets[0][2], 2);
  await f.controller.setPower(true);
  assert.equal(f.writes[2].packets[1][2], 32);
  assert.deepEqual(f.states.at(-1), { on: true, dim: 0.32, pattern: 'steady' });
});

test('concurrent brightness, pattern and off requests are serialized', async () => {
  const f = fixture();
  let active = 0;
  let maxActive = 0;
  f.transport.write = async (packets, keepConnected) => {
    maxActive = Math.max(maxActive, ++active);
    await new Promise(setImmediate);
    f.writes.push({ packets, keepConnected });
    active--;
  };
  await Promise.all([
    f.controller.setDim(0.25),
    f.controller.setPattern('candle'),
    f.controller.setPower(false),
  ]);
  assert.equal(maxActive, 1);
  assert.equal(f.states[1].dim, 0.25);
  assert.equal(f.states.at(-1).on, false);
  assert.equal(f.timers.size, 0);
});

test('effects stay within range and breathing follows its eight-second cycle', () => {
  assert.equal(patternDim('breathe', 1, 0), 0.2);
  assert.equal(patternDim('breathe', 1, 4000), 1);
  assert.equal(patternDim('breathe', 1, 8000), 0.2);
  assert.equal(patternDim('candle', 1, 0, () => 0), 0.65);
  assert.equal(patternDim('candle', 1, 0, () => 1), 1);
  assert.equal(patternDim('candle', 0.01, 0, () => 0), 0.01);
});

test('effects retain the connection, never update base brightness, and off cancels them', async () => {
  const f = fixture();
  await f.controller.setPattern('candle');
  assert.equal(f.writes[0].keepConnected, true);
  await f.tick();
  assert.equal(f.writes[1].packets.length, 1);
  assert.equal(f.writes[1].packets[0][1], 0x42);
  assert.equal(f.states.length, 1);
  await f.controller.setPower(false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.writes.at(-1).keepConnected, false);
  await f.controller.setPower(true);
  assert.equal(f.timers.size, 1);
  await f.controller.setPattern('steady');
  assert.equal(f.timers.size, 0);
  assert.equal(f.writes.at(-1).packets[1][2], 50);
  assert.equal(f.writes.at(-1).keepConnected, false);
});

test('Bluetooth failure preserves the committed state and automatically recovers availability', async () => {
  const f = fixture();
  const write = f.transport.write;
  f.transport.write = async () => { throw new Error('Disconnected'); };
  await assert.rejects(f.controller.setDim(0.8), /Disconnected/);
  assert.equal(f.states.length, 0);
  assert.deepEqual(f.availability, [false]);
  assert.equal([...f.timers.values()][0].ms, 30000);
  await f.tick();
  assert.deepEqual(f.availability, [false, true]);
  f.transport.write = write;
  await f.controller.setPower(true);
  assert.equal(f.writes[0].packets[1][2], 50);
});

test('failed pattern ticks pause effects and resume after a successful probe', async () => {
  const f = fixture();
  await f.controller.setPattern('breathe');
  const write = f.transport.write;
  f.transport.write = async () => { throw new Error('Out of range'); };
  await f.tick();
  assert.equal([...f.timers.values()][0].ms, 30000);
  f.transport.write = write;
  await f.tick();
  assert.equal([...f.timers.values()][0].ms, 1000);
  await f.tick();
  assert.equal(f.writes.length, 2);
});

test('restart only resumes an effect when the saved power state is on', async () => {
  const on = fixture({ on: true, pattern: 'candle' });
  await on.controller.start();
  assert.equal(on.timers.size, 1);
  const off = fixture({ pattern: 'candle' });
  await off.controller.start();
  assert.equal(off.timers.size, 0);
  assert.equal(off.writes.length, 0);
});

test('invalid controls do not send packets', async () => {
  const f = fixture();
  await assert.rejects(f.controller.setPattern('fire-native'));
  for (const dim of [-0.1, 1.1, NaN, Infinity]) {
    await assert.rejects(f.controller.setDim(dim));
  }
  assert.equal(f.writes.length, 0);
});

test('deletion cancels timers and waits for an in-flight write before closing', async () => {
  const f = fixture();
  let finish;
  let closed = false;
  f.transport.write = async () => { await new Promise(resolve => { finish = resolve; }); };
  f.transport.close = async () => { closed = true; };
  const write = f.controller.setPattern('candle');
  await new Promise(setImmediate);
  const stop = f.controller.stop();
  assert.equal(closed, false);
  finish();
  await Promise.all([write, stop]);
  assert.equal(closed, true);
  assert.equal(f.timers.size, 0);
  assert.equal(f.states.length, 0);
  await assert.rejects(f.controller.setPower(true), /removed/);
});

function bleFixture() {
  const events = [];
  let failures = 0;
  const peripheral = {
    isConnected: false,
    async disconnect() { events.push('disconnect'); this.isConnected = false; },
    async discoverAllServicesAndCharacteristics() {
      return [{
        uuid: 'candela-service',
        characteristics: [{
          uuid: 'AA7D3F34-2D4F-41E0-807F-52FBF8CF7443',
          async write(packet) {
            events.push(`write:${packet[1]}`);
            if (failures-- > 0) throw new Error('Write failed');
          },
        }],
      }];
    },
  };
  const ble = {
    async find(uuid) {
      assert.equal(uuid, 'lamp-id');
      events.push('find');
      return {
        async connect() {
          events.push('connect');
          peripheral.isConnected = true;
          return peripheral;
        },
      };
    },
  };
  const transport = new CandelaBle(ble, 'lamp-id', () => {});
  return { transport, events, setFailures(count) { failures = count; } };
}

test('BLE transport reconnects and replays an idempotent command after a failed write', async () => {
  const f = bleFixture();
  f.setFailures(1);
  await f.transport.write([powerCommand(true), brightnessCommand(0.5)]);
  assert.deepEqual(f.events, [
    'find', 'connect', 'write:64', 'disconnect',
    'find', 'connect', 'write:64', 'write:66', 'disconnect',
  ]);
});

test('BLE transport surfaces repeated failures and always releases the connection', async () => {
  const f = bleFixture();
  f.setFailures(2);
  await assert.rejects(f.transport.write([powerCommand(false)], true), /Write failed/);
  assert.equal(f.events.filter(event => event === 'connect').length, 2);
  assert.equal(f.events.filter(event => event === 'disconnect').length, 2);
});

test('BLE transport reuses a pattern connection but releases it for steady controls', async () => {
  const f = bleFixture();
  await f.transport.write([powerCommand(true)], true);
  await f.transport.write([brightnessCommand(0.5)], true);
  assert.equal(f.events.filter(event => event === 'connect').length, 1);
  assert.equal(f.events.filter(event => event === 'disconnect').length, 0);
  await f.transport.write([powerCommand(false)]);
  assert.equal(f.events.at(-1), 'disconnect');
});
