export const FIELD_ENCODING = {
  SIGNED_VB: 0,
  UNSIGNED_VB: 1,
  NEG_14BIT: 3,
  TAG8_8SVB: 6,
  TAG2_3S32: 7,
  TAG8_4S16: 8,
  NULL: 9,
  TAG2_3SVARIABLE: 10,
} as const

export const FIELD_ENCODING_NAME: Record<number, string> = {
  [FIELD_ENCODING.SIGNED_VB]: 'SIGNED_VB',
  [FIELD_ENCODING.UNSIGNED_VB]: 'UNSIGNED_VB',
  [FIELD_ENCODING.NEG_14BIT]: 'NEG_14BIT',
  [FIELD_ENCODING.TAG8_8SVB]: 'TAG8_8SVB',
  [FIELD_ENCODING.TAG2_3S32]: 'TAG2_3S32',
  [FIELD_ENCODING.TAG8_4S16]: 'TAG8_4S16',
  [FIELD_ENCODING.NULL]: 'NULL',
  [FIELD_ENCODING.TAG2_3SVARIABLE]: 'TAG2_3SVARIABLE',
}

export function signExtend(value: number, bits: number): number {
  const shift = 32 - bits
  return (value << shift) >> shift
}

export const signExtend2Bit = (value: number) => signExtend(value, 2)
export const signExtend4Bit = (value: number) => signExtend(value, 4)
export const signExtend5Bit = (value: number) => signExtend(value, 5)
export const signExtend6Bit = (value: number) => signExtend(value, 6)
export const signExtend7Bit = (value: number) => signExtend(value, 7)
export const signExtend8Bit = (value: number) => signExtend(value, 8)
export const signExtend14Bit = (value: number) => signExtend(value, 14)
export const signExtend16Bit = (value: number) => signExtend(value, 16)
export const signExtend24Bit = (value: number) => signExtend(value, 24)
