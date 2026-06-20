export function AircraftModel() {
  return (
    <group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.9, 0.26, 0.14]} />
        <meshStandardMaterial color="#d5dde8" metalness={0.35} roughness={0.45} />
      </mesh>

      <mesh position={[0.6, 0, 0]} rotation={[0, 0, -Math.PI / 2]} castShadow>
        <coneGeometry args={[0.12, 0.34, 20]} />
        <meshStandardMaterial color="#48c7ff" metalness={0.2} roughness={0.35} />
      </mesh>

      <mesh rotation={[0, 0, Math.PI / 4]} castShadow>
        <boxGeometry args={[1.5, 0.08, 0.05]} />
        <meshStandardMaterial color="#4f6785" />
      </mesh>

      <mesh rotation={[0, 0, -Math.PI / 4]} castShadow>
        <boxGeometry args={[1.5, 0.08, 0.05]} />
        <meshStandardMaterial color="#4f6785" />
      </mesh>

      {[
        [0.5, 0.5, 0],
        [0.5, -0.5, 0],
        [-0.5, 0.5, 0],
        [-0.5, -0.5, 0],
      ].map(([x, y, z], index) => (
        <mesh key={`${x}-${y}-${index}`} position={[x, y, z]} castShadow>
          <cylinderGeometry args={[0.08, 0.08, 0.05, 16]} />
          <meshStandardMaterial color={index < 2 ? '#ff8c6f' : '#7df0b6'} />
        </mesh>
      ))}
    </group>
  )
}
