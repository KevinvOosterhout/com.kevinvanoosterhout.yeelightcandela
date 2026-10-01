import type Homey from 'homey';

// The original Bluetooth Candela (YLFW01YL), not the Wi-Fi Yeelight protocol.
// Protocol references are linked in README.txt.
export const CONTROL_UUID = 'aa7d3f342d4f41e0807f52fbf8cf7443';

export function isCandela(advertisement: { localName?: string; connectable: boolean }) {
  return advertisement.connectable
    && /^yeelight_ms(?:$|[_ -])/i.test(advertisement.localName ?? '');
}

function command(opcode: number, value: number) {
  const packet = Buffer.alloc(18);
  packet[0] = 0x43;
  packet[1] = opcode;
  packet[2] = value;
  return packet;
}

export function powerCommand(on: boolean) {
  return command(0x40, on ? 0x01 : 0x02);
}

export function brightnessCommand(dim: number) {
  if (!Number.isFinite(dim) || dim <= 0 || dim > 1) {
    throw new Error('Brightness must be greater than 0 and at most 1');
  }
  return command(0x42, Math.max(1, Math.round(dim * 100)));
}

export default class CandelaBle {

  private peripheral?: Homey.BlePeripheral;
  private control?: Homey.BleCharacteristic;

  constructor(
    private readonly ble: { find(uuid: string): Promise<Homey.BleAdvertisement> },
    private readonly uuid: string,
    private readonly logError: (error: unknown) => void,
  ) {}

  private async connect() {
    if (this.peripheral?.isConnected && this.control) return;
    await this.close();
    const advertisement = await this.ble.find(this.uuid);
    this.peripheral = await advertisement.connect();
    // Locate the known control characteristic across discovered services rather
    // than assuming the bedside lamp's service UUID. Normalize characteristic UUIDs
    // because Homey/firmware versions may include Bluetooth UUID hyphens.
    const services = await this.peripheral.discoverAllServicesAndCharacteristics();
    this.control = services.flatMap((service) => service.characteristics)
      .find((characteristic) => characteristic.uuid.replace(/-/g, '').toLowerCase() === CONTROL_UUID);
    if (!this.control) {
      throw new Error(`Candela control characteristic not found: ${services.map((service) => (
        `${service.uuid}: ${service.characteristics.map((characteristic) => characteristic.uuid).join(', ')}`
      )).join('; ')}`);
    }
  }

  // Caller serializes operations. Replaying power/brightness commands is idempotent.
  async write(packets: Buffer[], keepConnected = false) {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.connect();
          for (const packet of packets) {
            await this.control!.write(packet);
          }
          return;
        } catch (error) {
          await this.close();
          if (attempt === 1) throw error;
        }
      }
    } finally {
      if (!keepConnected) await this.close();
    }
  }

  async probe() {
    await this.write([]);
  }

  async close() {
    const { peripheral } = this;
    this.peripheral = undefined;
    this.control = undefined;
    if (peripheral?.isConnected) {
      await peripheral.disconnect().catch(this.logError);
    }
  }

}
