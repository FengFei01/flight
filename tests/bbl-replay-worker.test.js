const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseBBLForReplay,
  resolveGyroScaleFactor,
  scaleGyroSample,
} = require('../public/js/bbl-replay-worker');

function buildReplayBuffer(rawSamples, gyroScale = '0.00106526') {
  const header = [
    'H Product:Betaflight',
    'H Firmware revision:4.4.2',
    'H Craft name:Scale Test Quad',
    'H Board information:SPEEDYBEEF405V3',
    'H looptime:125',
    `H gyro_scale:${gyroScale}`,
    'H motorOutput:1000,2000',
    'I',
  ].join('\n') + '\n';

  const binary = Buffer.alloc(rawSamples.length * 14);
  rawSamples.forEach((sample, index) => {
    const offset = index * 14;
    binary.writeInt16LE(sample.roll, offset);
    binary.writeInt16LE(sample.pitch, offset + 2);
    binary.writeInt16LE(sample.yaw, offset + 4);
    binary.writeUInt16LE(sample.motor0 || 1200, offset + 6);
    binary.writeUInt16LE(sample.motor1 || 1300, offset + 8);
    binary.writeUInt16LE(sample.motor2 || 1400, offset + 10);
    binary.writeUInt16LE(sample.motor3 || 1500, offset + 12);
  });

  const buffer = Buffer.concat([Buffer.from(header, 'latin1'), binary]);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('BBL replay gyro scaling', () => {
  it('converts Betaflight gyro_scale from rad/s raw ticks to degrees/s', () => {
    const factor = resolveGyroScaleFactor({ gyroScale: 0.00106526 });

    assert.ok(Math.abs(factor - 0.061034902) < 0.000001);
    assert.ok(Math.abs(scaleGyroSample(25957, factor) - 1584.28) < 0.1);
    assert.ok(scaleGyroSample(29295, factor) < 2000);
  });

  it('keeps degree-per-tick scale values as-is', () => {
    assert.equal(resolveGyroScaleFactor({ gyroScale: 0.061 }), 0.061);
  });

  it('returns replay gyro series in degrees/s instead of raw ADC values', () => {
    const samples = new Array(12).fill(null).map(() => ({
      roll: 25957,
      pitch: -26212,
      yaw: 29295,
    }));
    const parsed = parseBBLForReplay(buildReplayBuffer(samples));

    assert.equal(parsed.frames.count, 11);
    assert.ok(parsed.frames.gyroRoll[0] > 1583);
    assert.ok(parsed.frames.gyroRoll[0] < 1585);
    assert.ok(parsed.frames.gyroPitch[0] < -1599);
    assert.ok(parsed.frames.gyroPitch[0] > -1601);
    assert.ok(parsed.frames.gyroYaw[0] < 1789);
    assert.ok(parsed.frames.gyroYaw[0] > 1787);
  });
});
