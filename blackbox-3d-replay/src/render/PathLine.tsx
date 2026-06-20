import { Line } from '@react-three/drei'
import type { Vector3 } from 'three'

type PathLineProps = {
  points: Vector3[]
}

export function PathLine({ points }: PathLineProps) {
  if (points.length < 2) {
    return null
  }

  return <Line points={points} color="#6fe3ff" lineWidth={1.8} transparent opacity={0.9} />
}
