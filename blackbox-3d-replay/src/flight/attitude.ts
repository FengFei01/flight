import type { FlightSample, LocalPosition, ReplayFrame } from '../blackbox/types'
import { gpsToLocalENU, degToRad } from './coordinates'

export const ATTITUDE_CONFIG = {
  gyroScale: 1,
  accCorrectionAlpha: 0.02,
  gpsYawCorrectionAlpha: 0.005,
  minGpsSpeedForYaw: 2,
}

export function estimateAttitude(
  samples: FlightSample[],
  config = ATTITUDE_CONFIG,
): ReplayFrame[] {
  if (samples.length === 0) {
    return []
  }

  let roll = 0
  let pitch = 0
  let yaw = findInitialYaw(samples)
  let position: LocalPosition = { x: 0, y: 0, z: 0 }
  let relativeSpeed = 0

  const origin = findOrigin(samples)

  return samples.map((sample, index) => {
    const previous = samples[index - 1]
    const dt = previous ? Math.max(0.0005, sample.t - previous.t) : 0
    const gyro = sample.gyro ?? [0, 0, 0]

    roll += degToRad(gyro[0] * config.gyroScale) * dt
    pitch += degToRad(gyro[1] * config.gyroScale) * dt
    yaw += degToRad(gyro[2] * config.gyroScale) * dt

    if (sample.acc) {
      const [ax, ay, az] = sample.acc
      const accRoll = Math.atan2(ay, az || 1e-6)
      const accPitch = Math.atan2(-ax, Math.hypot(ay, az))
      roll = lerpAngle(roll, accRoll, config.accCorrectionAlpha)
      pitch = lerpAngle(pitch, accPitch, config.accCorrectionAlpha)
    }

    if (
      sample.gps?.groundCourse !== undefined &&
      (sample.gps.speed ?? 0) >= config.minGpsSpeedForYaw
    ) {
      const gpsYaw = courseToYaw(sample.gps.groundCourse)
      yaw = lerpAngle(yaw, gpsYaw, config.gpsYawCorrectionAlpha)
    }

    if (sample.gps && origin) {
      const altitude = sample.baroAlt ?? sample.gps.alt ?? origin.alt
      position = gpsToLocalENU(
        sample.gps.lat,
        sample.gps.lon,
        altitude,
        origin.lat,
        origin.lon,
        origin.alt,
      )
    } else if (dt > 0) {
      const throttle = deriveThrottle(sample)
      relativeSpeed = lerp(relativeSpeed, throttle * 14, 0.08)
      const forward = {
        x: Math.cos(yaw) * Math.cos(pitch),
        y: Math.sin(yaw) * Math.cos(pitch),
        z: -Math.sin(pitch),
      }

      position = {
        x: position.x + forward.x * relativeSpeed * dt,
        y: position.y + forward.y * relativeSpeed * dt,
        z:
          (sample.baroAlt ?? position.z) +
          (throttle - 0.5) * 1.8 * dt,
      }
    } else if (sample.baroAlt !== undefined) {
      position = { ...position, z: sample.baroAlt }
    }

    const quaternion = eulerToQuaternion(roll, pitch, yaw)

    return {
      t: sample.t,
      position,
      euler: { roll, pitch, yaw },
      quaternion,
      telemetry: sample,
    }
  })
}

type Origin = {
  lat: number
  lon: number
  alt: number
}

function findOrigin(samples: FlightSample[]): Origin | null {
  for (const sample of samples) {
    if (sample.gpsHome) {
      return {
        lat: sample.gpsHome.lat,
        lon: sample.gpsHome.lon,
        alt: sample.gpsHome.alt ?? sample.baroAlt ?? sample.gps?.alt ?? 0,
      }
    }
  }

  for (const sample of samples) {
    if (sample.gps) {
      return {
        lat: sample.gps.lat,
        lon: sample.gps.lon,
        alt: sample.baroAlt ?? sample.gps.alt ?? 0,
      }
    }
  }

  return null
}

function findInitialYaw(samples: FlightSample[]): number {
  for (const sample of samples) {
    if (sample.gps?.groundCourse !== undefined) {
      return courseToYaw(sample.gps.groundCourse)
    }
  }

  return 0
}

function courseToYaw(courseDegrees: number): number {
  return Math.PI / 2 - degToRad(courseDegrees)
}

function deriveThrottle(sample: FlightSample): number {
  if (sample.rc?.[3] !== undefined) {
    const throttle = sample.rc[3]
    if (throttle > 1000) {
      return clamp01((throttle - 1000) / 1000)
    }
    return clamp01(throttle / 500)
  }

  if (sample.motor?.length) {
    const average = sample.motor.reduce((sum, value) => sum + value, 0) / sample.motor.length
    if (average > 1000) {
      return clamp01((average - 1000) / 1000)
    }
  }

  return 0.35
}

function eulerToQuaternion(roll: number, pitch: number, yaw: number) {
  const cy = Math.cos(yaw * 0.5)
  const sy = Math.sin(yaw * 0.5)
  const cp = Math.cos(pitch * 0.5)
  const sp = Math.sin(pitch * 0.5)
  const cr = Math.cos(roll * 0.5)
  const sr = Math.sin(roll * 0.5)

  return {
    w: cr * cp * cy + sr * sp * sy,
    x: sr * cp * cy - cr * sp * sy,
    y: cr * sp * cy + sr * cp * sy,
    z: cr * cp * sy - sr * sp * cy,
  }
}

function lerpAngle(current: number, target: number, alpha: number): number {
  const delta = wrapAngle(target - current)
  return current + delta * alpha
}

function wrapAngle(value: number): number {
  let angle = value

  while (angle > Math.PI) {
    angle -= Math.PI * 2
  }

  while (angle < -Math.PI) {
    angle += Math.PI * 2
  }

  return angle
}

function lerp(current: number, target: number, alpha: number): number {
  return current + (target - current) * alpha
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
