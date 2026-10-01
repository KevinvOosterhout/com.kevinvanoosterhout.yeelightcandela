import Homey from 'homey';
import { isCandela } from '../../lib/candela-ble.ts';
import type CandelaDevice from './device.ts';

export default class CandelaDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('set_candela_pattern')
      .registerRunListener(async (args: { device: CandelaDevice; pattern: string }) => {
        await args.device.setPattern(args.pattern);
        return true;
      });
  }

  async onPairListDevices() {
    const advertisements = await this.homey.ble.discover();
    const paired = new Set(this.getDevices().map((device) => device.getData().id));
    return advertisements
      .filter((advertisement) => isCandela(advertisement) && !paired.has(advertisement.uuid))
      .map((advertisement) => ({
        name: `Candela ${advertisement.address?.slice(-5) || advertisement.uuid.slice(-4)}`,
        data: { id: advertisement.uuid },
      }));
  }

}
