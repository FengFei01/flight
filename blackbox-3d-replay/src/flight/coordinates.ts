import type { LocalPosition } from '../blackbox/types'

const EARTH_RADIUS_METERS = 6378137

export function degToRad(value: number): number {
  return (value * Math.PI) / 180
}

export function radToDeg(value: number): number {
  return (value * 180) / Math.PI
}

export function gpsToLocalENU(
  lat: number,
  lon: number,
  alt: number,
  originLat: number,
  originLon: number,
  originAlt: number,
): LocalPosition {
  const dLat = degToRad(lat - originLat)
  const dLon = degToRad(lon - originLon)
  const meanLat = degToRad((lat + originLat) / 2)

  return {
    x: EARTH_RADIUS_METERS * dLon * Math.cos(meanLat),
    y: EARTH_RADIUS_METERS * dLat,
    z: alt - originAlt,
  }
}
