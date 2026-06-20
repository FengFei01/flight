import {
  signExtend2Bit,
  signExtend4Bit,
  signExtend5Bit,
  signExtend6Bit,
  signExtend7Bit,
  signExtend8Bit,
  signExtend16Bit,
  signExtend24Bit,
} from './encoders'

export class BlackboxReader {
  private readonly bytes: Uint8Array

  private readonly limit: number

  private cursor: number

  constructor(bytes: Uint8Array, start = 0, end = bytes.length) {
    this.bytes = bytes
    this.cursor = start
    this.limit = Math.min(end, bytes.length)
  }

  get offset(): number {
    return this.cursor
  }

  set offset(next: number) {
    this.cursor = Math.max(0, Math.min(next, this.limit))
  }

  get eof(): boolean {
    return this.cursor >= this.limit
  }

  readByte(): number {
    if (this.cursor >= this.limit) {
      throw new Error('Unexpected EOF while reading byte')
    }

    return this.bytes[this.cursor++]
  }

  readS8(): number {
    return signExtend8Bit(this.readByte())
  }

  readS16(): number {
    const low = this.readByte()
    const high = this.readByte()
    return signExtend16Bit(low | (high << 8))
  }

  readU32(): number {
    const b0 = this.readByte()
    const b1 = this.readByte()
    const b2 = this.readByte()
    const b3 = this.readByte()
    return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0
  }

  readString(length: number): string {
    const start = this.cursor
    this.cursor = Math.min(this.cursor + length, this.limit)
    return new TextDecoder('iso-8859-1').decode(this.bytes.slice(start, this.cursor))
  }

  readUnsignedVB(): number {
    let value = 0
    let shift = 0

    while (true) {
      const next = this.readByte()
      value |= (next & 0x7f) << shift

      if ((next & 0x80) === 0) {
        return value >>> 0
      }

      shift += 7

      if (shift > 35) {
        throw new Error('Variable-byte integer is too large')
      }
    }
  }

  readSignedVB(): number {
    const value = this.readUnsignedVB()
    return (value >>> 1) ^ -(value & 1)
  }

  readTag2_3S32(values = [0, 0, 0]): number[] {
    let leadByte = this.readByte()

    switch (leadByte >> 6) {
      case 0:
        values[0] = signExtend2Bit((leadByte >> 4) & 0x03)
        values[1] = signExtend2Bit((leadByte >> 2) & 0x03)
        values[2] = signExtend2Bit(leadByte & 0x03)
        break
      case 1:
        values[0] = signExtend4Bit(leadByte & 0x0f)
        leadByte = this.readByte()
        values[1] = signExtend4Bit(leadByte >> 4)
        values[2] = signExtend4Bit(leadByte & 0x0f)
        break
      case 2:
        values[0] = signExtend6Bit(leadByte & 0x3f)
        values[1] = signExtend6Bit(this.readByte() & 0x3f)
        values[2] = signExtend6Bit(this.readByte() & 0x3f)
        break
      case 3:
        for (let index = 0; index < 3; index += 1) {
          switch (leadByte & 0x03) {
            case 0:
              values[index] = signExtend8Bit(this.readByte())
              break
            case 1: {
              const b0 = this.readByte()
              const b1 = this.readByte()
              values[index] = signExtend16Bit(b0 | (b1 << 8))
              break
            }
            case 2: {
              const b0 = this.readByte()
              const b1 = this.readByte()
              const b2 = this.readByte()
              values[index] = signExtend24Bit(b0 | (b1 << 8) | (b2 << 16))
              break
            }
            case 3: {
              const b0 = this.readByte()
              const b1 = this.readByte()
              const b2 = this.readByte()
              const b3 = this.readByte()
              values[index] = (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >> 0
              break
            }
          }

          leadByte >>= 2
        }
        break
      default:
        break
    }

    return values
  }

  readTag2_3SVariable(values = [0, 0, 0]): number[] {
    const leadByte = this.readByte()

    switch (leadByte >> 6) {
      case 0:
        values[0] = signExtend2Bit((leadByte >> 4) & 0x03)
        values[1] = signExtend2Bit((leadByte >> 2) & 0x03)
        values[2] = signExtend2Bit(leadByte & 0x03)
        break
      case 1: {
        const leadByte2 = this.readByte()
        values[0] = signExtend5Bit((leadByte & 0x3e) >> 1)
        values[1] = signExtend5Bit(((leadByte & 0x01) << 4) | (leadByte2 >> 4))
        values[2] = signExtend4Bit(leadByte2 & 0x0f)
        break
      }
      case 2: {
        const leadByte2 = this.readByte()
        const leadByte3 = this.readByte()
        values[0] = signExtend8Bit(((leadByte & 0x3f) << 2) | ((leadByte2 & 0xc0) >> 6))
        values[1] = signExtend7Bit(((leadByte2 & 0x3f) << 1) | ((leadByte3 & 0x80) >> 7))
        values[2] = signExtend7Bit(leadByte3 & 0x7f)
        break
      }
      case 3:
        return this.readTag2_3S32(values)
      default:
        break
    }

    return values
  }

  readTag8_4S16(version: number, values = [0, 0, 0, 0]): number[] {
    if (version < 2) {
      return this.readTag8_4S16_v1(values)
    }
    return this.readTag8_4S16_v2(values)
  }

  readTag8_4S16_v1(values = [0, 0, 0, 0]): number[] {
    let selector = this.readByte()

    for (let index = 0; index < 4; index += 1) {
      switch (selector & 0x03) {
        case 0:
          values[index] = 0
          break
        case 1: {
          const combined = this.readByte()
          values[index] = signExtend4Bit(combined & 0x0f)
          index += 1
          selector >>= 2
          if (index < 4) {
            values[index] = signExtend4Bit(combined >> 4)
          }
          break
        }
        case 2:
          values[index] = signExtend8Bit(this.readByte())
          break
        case 3: {
          const b0 = this.readByte()
          const b1 = this.readByte()
          values[index] = signExtend16Bit(b0 | (b1 << 8))
          break
        }
      }

      selector >>= 2
    }

    return values
  }

  readTag8_4S16_v2(values = [0, 0, 0, 0]): number[] {
    let selector = this.readByte()
    let buffer = 0
    let nibbleIndex = 0

    for (let index = 0; index < 4; index += 1) {
      switch (selector & 0x03) {
        case 0:
          values[index] = 0
          break
        case 1:
          if (nibbleIndex === 0) {
            buffer = this.readByte()
            values[index] = signExtend4Bit(buffer >> 4)
            nibbleIndex = 1
          } else {
            values[index] = signExtend4Bit(buffer & 0x0f)
            nibbleIndex = 0
          }
          break
        case 2:
          if (nibbleIndex === 0) {
            values[index] = signExtend8Bit(this.readByte())
          } else {
            let byte = (buffer & 0x0f) << 4
            buffer = this.readByte()
            byte |= buffer >> 4
            values[index] = signExtend8Bit(byte)
          }
          break
        case 3:
          if (nibbleIndex === 0) {
            const b0 = this.readByte()
            const b1 = this.readByte()
            values[index] = signExtend16Bit((b0 << 8) | b1)
          } else {
            const b0 = this.readByte()
            const b1 = this.readByte()
            values[index] = signExtend16Bit(((buffer & 0x0f) << 12) | (b0 << 4) | (b1 >> 4))
            buffer = b1
          }
          break
      }

      selector >>= 2
    }

    return values
  }

  readTag8_8SVB(valueCount: number, values = new Array<number>(8).fill(0)): number[] {
    if (valueCount <= 1) {
      values[0] = this.readSignedVB()
      return values
    }

    let header = this.readByte()

    for (let index = 0; index < valueCount; index += 1, header >>= 1) {
      values[index] = header & 0x01 ? this.readSignedVB() : 0
    }

    return values
  }
}
