import { OrbitControls } from '@react-three/drei'
import { Canvas, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Quaternion, Vector3 } from 'three'
import type { ReplayFrame } from '../blackbox/types'
import { AircraftModel } from './AircraftModel'
import { PathLine } from './PathLine'

type FlightSceneProps = {
  replayFrames: ReplayFrame[]
  currentFrameIndex: number
}

export function FlightScene({ replayFrames, currentFrameIndex }: FlightSceneProps) {
  if (replayFrames.length === 0) {
    return (
      <div className="scene-empty">
        <p>Upload a `.bbl` file and choose a segment to build the 3D replay.</p>
      </div>
    )
  }

  return (
    <Canvas shadows camera={{ position: [-18, -18, 12], fov: 45 }}>
      <SceneContent replayFrames={replayFrames} currentFrameIndex={currentFrameIndex} />
    </Canvas>
  )
}

function SceneContent({ replayFrames, currentFrameIndex }: FlightSceneProps) {
  const points = useMemo(
    () => replayFrames.map((frame) => new Vector3(frame.position.x, frame.position.y, frame.position.z)),
    [replayFrames],
  )

  const bounds = useMemo(() => {
    const min = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)
    const max = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY)

    for (const point of points) {
      min.min(point)
      max.max(point)
    }

    const center = min.clone().add(max).multiplyScalar(0.5)
    const size = max.clone().sub(min)
    const radius = Math.max(12, size.length() * 0.65 || 12)

    return { center, radius }
  }, [points])

  const current = replayFrames[Math.min(currentFrameIndex, replayFrames.length - 1)]
  const quaternion = useMemo(
    () =>
      new Quaternion(
        current.quaternion.x,
        current.quaternion.y,
        current.quaternion.z,
        current.quaternion.w,
      ),
    [current],
  )

  const gridSize = Math.max(30, bounds.radius * 2.6)

  return (
    <>
      <SceneCamera center={bounds.center} radius={bounds.radius} />
      <color attach="background" args={['#081018']} />
      <fog attach="fog" args={['#081018', bounds.radius * 1.8, bounds.radius * 4.5]} />
      <ambientLight intensity={0.48} />
      <directionalLight
        position={[bounds.center.x + 12, bounds.center.y - 16, bounds.center.z + 20]}
        intensity={1.6}
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
      />

      <gridHelper args={[gridSize, 24, '#335979', '#162637']} rotation={[Math.PI / 2, 0, 0]} />
      <axesHelper args={[Math.max(4, bounds.radius * 0.3)]} />

      <PathLine points={points} />

      <mesh position={points[0]} castShadow>
        <sphereGeometry args={[0.22, 18, 18]} />
        <meshStandardMaterial color="#62f3a0" emissive="#1d5e40" emissiveIntensity={0.4} />
      </mesh>

      <mesh position={points[points.length - 1]} castShadow>
        <sphereGeometry args={[0.22, 18, 18]} />
        <meshStandardMaterial color="#ff7e6d" emissive="#742a20" emissiveIntensity={0.4} />
      </mesh>

      <group position={points[Math.min(currentFrameIndex, points.length - 1)]} quaternion={quaternion}>
        <AircraftModel />
      </group>
    </>
  )
}

type SceneCameraProps = {
  center: Vector3
  radius: number
}

function SceneCamera({ center, radius }: SceneCameraProps) {
  const { camera } = useThree()

  useEffect(() => {
    camera.up.set(0, 0, 1)
    camera.position.set(center.x - radius * 1.15, center.y - radius * 1.25, center.z + radius * 0.8)
    camera.lookAt(center.x, center.y, center.z)
  }, [camera, center, radius])

  return (
    <OrbitControls
      makeDefault
      enableDamping
      dampingFactor={0.08}
      target={[center.x, center.y, center.z]}
      minDistance={4}
      maxDistance={radius * 8}
    />
  )
}
