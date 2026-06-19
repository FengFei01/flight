const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildDisplayMotion } = require('../public/js/flight-replay');

function makeFrames(count, rates) {
  return {
    count,
    durationSec: count / 60,
    sampleRateHz: 60,
    gyroRoll: new Array(count).fill(rates.roll || 0),
    gyroPitch: new Array(count).fill(rates.pitch || 0),
    gyroYaw: new Array(count).fill(rates.yaw || 0),
  };
}

describe('Flight replay display motion', () => {
  it('keeps roll and pitch bounded even during sustained high gyro rates', () => {
    const motion = buildDisplayMotion(makeFrames(240, {
      roll: 2000,
      pitch: -2000,
      yaw: 2000,
    }));

    assert.equal(motion.roll.length, 240);
    assert.ok(Math.max(...motion.roll) <= 45);
    assert.ok(Math.min(...motion.pitch) >= -45);
  });

  it('does not use instantaneous gyro rate as the rendered angle', () => {
    const motion = buildDisplayMotion(makeFrames(2, {
      roll: 1584,
      pitch: -1600,
      yaw: 1788,
    }));

    assert.ok(Math.abs(motion.roll[0]) < 2);
    assert.ok(Math.abs(motion.pitch[0]) < 2);
    assert.ok(Math.abs(motion.yaw[0]) < 1);
  });

  it('ignores invalid samples instead of producing NaN angles', () => {
    const frames = makeFrames(3, { roll: 0, pitch: 0, yaw: 0 });
    frames.gyroRoll[1] = Infinity;
    frames.gyroPitch[1] = NaN;
    frames.gyroYaw[1] = undefined;

    const motion = buildDisplayMotion(frames);

    for (const series of [motion.roll, motion.pitch, motion.yaw]) {
      assert.ok(series.every(Number.isFinite));
    }
  });
});
